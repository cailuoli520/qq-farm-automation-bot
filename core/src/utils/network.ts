import { Buffer } from 'node:buffer';
import EventEmitter from 'node:events';
import process from 'node:process';
import { CONFIG, getClientVersion, getVersionPrefix, setClientVersionPrefix } from '../config/config';
import { startAceRuntime, stopAceRuntime } from '../services/ace';
import { createScheduler } from '../services/scheduler';
import { recordOperation } from '../services/stats';
import { updateStatusFromLogin, updateStatusGold, updateStatusLevel } from '../services/status';
import * as cryptoWasm from './crypto-wasm';
import { encodeGatewayRequest, GatewayTokenProvider } from './gateway-request';
import { MAX_HEARTBEAT_MISSES, shouldReconnectForHeartbeat } from './keepalive-policy';
import { decodeMessage, encodeMessage } from './proto';
import { canReserveRequest } from './request-coordination';
import type { RequestCategory } from './request-coordination';
import { log, logWarn, syncServerTime, toLong, toNum } from './utils';

/**
 * WebSocket 网络层 - 连接/消息编解码/登录/心跳
 */

type DataRecord = Record<string, unknown>;
type RawData = Buffer | ArrayBuffer | Buffer[];
type GatewayCallback = (error: Error | null, body?: Uint8Array, meta?: DataRecord) => void;
type LoginSuccessCallback = () => void | Promise<void>;

export type ConnectionPhase = 'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'backoff' | 'reauth-required';

export interface ConnectionStateSnapshot {
    phase: ConnectionPhase;
    ready: boolean;
    revision: number;
    reconnectAttempt: number;
    changedAt: number;
    reason: string;
}

interface WebSocketLike extends EventEmitter {
    readyState: number;
    binaryType: string;
    send: (payload: Uint8Array, callback: (error?: Error) => void) => void;
    close: () => void;
}

interface WebSocketConstructor {
    new(url: string, options?: { headers?: Record<string, string>; handshakeTimeout?: number }): WebSocketLike;
    OPEN: number;
}

const WebSocket = require('ws') as WebSocketConstructor;

interface PendingCallbackEntry {
    callback: GatewayCallback;
    serviceName: string;
    methodName: string;
    category: RequestCategory;
    startedAt: number;
    sentAt: number;
    revision: number;
}

interface SendOptions {
    timeoutMs?: number;
    category?: RequestCategory;
    expectedErrorCodes?: readonly number[];
}

interface UserState {
    gid: number;
    name: string;
    level: number;
    gold: number;
    exp: number;
    openid: string;
    coupon: number;
    goldBean: number;
    diamond: number | null;
}

interface WsErrorState {
    code: number;
    at: number;
    message: string;
}

interface GatewayResponse {
    body: Uint8Array;
    meta: DataRecord;
}

function asRecord(value: unknown): DataRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as DataRecord
        : {};
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function recordArray(value: unknown): DataRecord[] {
    return Array.isArray(value)
        ? value.filter((item): item is DataRecord => Boolean(
            item && typeof item === 'object' && !Array.isArray(item),
        ))
        : [];
}

function toBuffer(value: RawData | Uint8Array | ArrayBuffer | unknown): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return Buffer.concat(value.filter(Buffer.isBuffer));
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return Buffer.alloc(0);
}

// ============ 事件发射器 (用于推送通知) ============
const networkEvents = new EventEmitter();

// ============ 内部状态 ============
let ws: WebSocketLike | null = null;
let clientSeq = 1;
let serverSeq = 0;
const pendingCallbacks = new Map<number, PendingCallbackEntry>();
let wsErrorState: WsErrorState = { code: 0, at: 0, message: '' };
const networkScheduler = createScheduler('network');
const MAX_PENDING_REQUESTS = 5;
const MAX_BUSINESS_REQUESTS = 4;
function configuredTimeout(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

const WS_HANDSHAKE_TIMEOUT_MS = configuredTimeout('FARM_WS_HANDSHAKE_TIMEOUT_MS', 10_000);
const LOGIN_TIMEOUT_MS = configuredTimeout('FARM_LOGIN_TIMEOUT_MS', 20_000);
const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000] as const;
let connectionRevision = 0;
let reconnectAttempt = 0;
let lastInboundAt = Date.now();
let lastPressureLogAt = 0;
const gatewayTokens = new GatewayTokenProvider();
let connectionState: ConnectionStateSnapshot = {
    phase: 'disconnected',
    ready: false,
    revision: connectionRevision,
    reconnectAttempt,
    changedAt: Date.now(),
    reason: '尚未连接',
};

export function computeReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
    const index = Math.min(RECONNECT_DELAYS_MS.length - 1, Math.max(0, Math.floor(attempt) - 1));
    const base = RECONNECT_DELAYS_MS[index];
    const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
    return Math.min(RECONNECT_DELAYS_MS.at(-1)!, Math.max(1_000, Math.round(base * jitter)));
}

function setConnectionPhase(phase: ConnectionPhase, reason = ''): void {
    const previous = connectionState;
    connectionState = {
        phase,
        ready: phase === 'ready',
        revision: connectionRevision,
        reconnectAttempt,
        changedAt: Date.now(),
        reason: String(reason || ''),
    };
    networkEvents.emit('connectionStateChanged', { ...connectionState });
    if (previous.ready && !connectionState.ready) {
        networkEvents.emit('disconnected', { ...connectionState });
    }
    if (previous.phase !== phase || previous.revision !== connectionState.revision) {
        log('系统', `连接状态 ${previous.phase} → ${phase}${reason ? ` (${reason})` : ''}`, {
            module: 'network',
            event: 'connection_state',
            phase,
            previousPhase: previous.phase,
            revision: connectionRevision,
            reconnectAttempt,
            accountId: String(process.env.FARM_ACCOUNT_ID || ''),
        });
    }
}

function resetConnectionProtocolState(): void {
    clientSeq = 1;
    serverSeq = 0;
    lastInboundAt = Date.now();
    lastPressureLogAt = 0;
    gatewayTokens.clear();
}

function describePendingRequests(limit = MAX_PENDING_REQUESTS): string {
    if (pendingCallbacks.size === 0) return 'none';
    const now = Date.now();
    return Array.from(pendingCallbacks.entries())
        .slice(0, Math.max(1, limit))
        .map(([seq, entry]) => {
            const ageMs = Math.max(0, now - entry.startedAt);
            const stage = entry.sentAt > 0 ? 'sent' : 'encoding';
            return `${entry.methodName}#${seq}:${ageMs}ms:${stage}:${entry.category}`;
        })
        .join(',');
}

function requestPressureDetails(): string {
    return `pending=${pendingCallbacks.size}, active=${describePendingRequests()}, lastInbound=${Math.max(0, Date.now() - lastInboundAt)}ms`;
}

function logRequestPressure(methodName: string): void {
    const now = Date.now();
    if (now - lastPressureLogAt < 5000) return;
    lastPressureLogAt = now;
    logWarn('系统', `Gateway 请求压力: rejected=${methodName}, ${requestPressureDetails()}`);
}

function rejectAllPendingRequests(reason = '请求被中断'): number {
    const entries = Array.from(pendingCallbacks.entries());
    pendingCallbacks.clear();
    for (const [seq, entry] of entries) {
        networkScheduler.clear(`request_timeout_${seq}`);
        try {
            entry.callback(new Error(reason));
        } catch {
            // ignore callback failure
        }
    }
    return entries.length;
}

// ============ 用户状态 (登录后设置) ============
const userState: UserState = {
    gid: 0,
    name: '',
    level: 0,
    gold: 0,
    exp: 0,
    openid: '',
    coupon: 0, // 点券(ID:1002)
    goldBean: 0, // 金豆豆(ID:1005)
    diamond: null, // 钻石(ID:1004)，需通过充值信息或推送确认
};

function getUserState(): UserState { return userState; }
function getWsErrorState(): WsErrorState { return { ...wsErrorState }; }
function setWsErrorState(code: unknown, message: unknown): void {
    wsErrorState = { code: Number(code) || 0, at: Date.now(), message: String(message || '') };
}
function clearWsErrorState(): void {
    wsErrorState = { code: 0, at: 0, message: '' };
}

function hasOwn(obj: unknown, key: PropertyKey): boolean {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// ============ 消息编解码 ============
// async function encodeMsg(serviceName, methodName, bodyBytes) {
async function encodeMsg(
    serviceName: string,
    methodName: string,
    bodyBytes: Uint8Array | null | undefined,
    clientSeqValue: number,
): Promise<Uint8Array> {
    let finalBody = bodyBytes || Buffer.alloc(0);
    if (finalBody.length > 0) {
        finalBody = await cryptoWasm.encryptBuffer(finalBody);
    }
    return encodeGatewayRequest(
        serviceName,
        methodName,
        finalBody,
        clientSeqValue,
        serverSeq,
        gatewayTokens.next(),
    );
}

/** 网关错误（含服务端错误码） */
class GatewayError extends Error {
    readonly code: number;
    readonly serviceName: string;
    readonly methodName: string;
    readonly errorMessage: string;
    readonly clientSeq: number;

    constructor(metaValue: unknown) {
        const meta = asRecord(metaValue);
        const code = toNum(meta.error_code);
        const serviceName = String(meta.service_name || '');
        const methodName = String(meta.method_name || '');
        const gatewayErrorMessage = String(meta.error_message || '');
        super(`${serviceName}.${methodName} 错误: code=${code} ${gatewayErrorMessage}`.trim());
        this.name = 'GatewayError';
        this.code = code;
        this.serviceName = serviceName;
        this.methodName = methodName;
        this.errorMessage = gatewayErrorMessage;
        this.clientSeq = toNum(meta.client_seq);
    }
}

class RequestTimeoutError extends Error {
    readonly code = 'REQUEST_TIMEOUT';
    readonly sentAt: number;

    constructor(message: string, sentAt: number) {
        super(message);
        this.name = 'RequestTimeoutError';
        this.sentAt = sentAt;
    }
}

class ConnectionNotReadyError extends Error {
    readonly code = 'CONNECTION_NOT_READY';

    constructor(methodName: string, phase: ConnectionPhase) {
        super(`连接未就绪: ${methodName} (phase=${phase})`);
        this.name = 'ConnectionNotReadyError';
    }
}

/** Promise 版发送（timeoutOrOptions 支持数字超时或 { timeoutMs, expectedErrorCodes } 选项对象） */
function sendMsgAsync(
    serviceName: string,
    methodName: string,
    bodyBytes: Uint8Array | null | undefined,
    timeoutOrOptions: number | SendOptions = 20000,
): Promise<GatewayResponse> {
    const options = typeof timeoutOrOptions === 'number'
        ? { timeoutMs: timeoutOrOptions }
        : (timeoutOrOptions || {});
    const timeout = Math.max(1, Number(options.timeoutMs) || 20000);
    const category: RequestCategory = options.category === 'control' ? 'control' : 'business';
    return new Promise<GatewayResponse>((resolve, reject) => {
        // 检查连接状态
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error(`连接未打开: ${methodName}`));
            return;
        }

        if (category === 'business' && !connectionState.ready) {
            reject(new ConnectionNotReadyError(methodName, connectionState.phase));
            return;
        }

        if (!canReserveRequest(pendingCallbacks.values(), category, {
            maxPending: MAX_PENDING_REQUESTS,
            maxBusiness: MAX_BUSINESS_REQUESTS,
        })) {
            logRequestPressure(methodName);
            reject(new Error(`请求队列已满: ${methodName} (${requestPressureDetails()})`));
            return;
        }

        const socket = ws;
        const revision = connectionRevision;
        const seq = clientSeq++;
        const timeoutKey = `request_timeout_${seq}`;
        let completed = false;
        const startedAt = Date.now();
        const finish: GatewayCallback = (error, body = Buffer.alloc(0), meta = {}) => {
            if (completed) return;
            completed = true;
            pendingCallbacks.delete(seq);
            networkScheduler.clear(timeoutKey);
            if (error) reject(error);
            else resolve({ body, meta });
        };
        const entry = {
            callback: finish,
            serviceName,
            methodName,
            category,
            startedAt,
            sentAt: 0,
            revision,
        };
        pendingCallbacks.set(seq, entry);
        networkScheduler.setTimeoutTask(timeoutKey, timeout, () => {
            const error = new RequestTimeoutError(
                `请求超时: ${methodName} (seq=${seq}, elapsed=${Date.now() - startedAt}ms, ${requestPressureDetails()})`,
                entry.sentAt,
            );
            finish(error);
        });

        Promise.resolve().then(async () => {
            const encoded = await encodeMsg(serviceName, methodName, bodyBytes, seq);
            if (completed) return;
            if (revision !== connectionRevision || socket !== ws || socket.readyState !== WebSocket.OPEN) {
                throw new Error(`请求已中断: ${methodName}`);
            }
            entry.sentAt = Date.now();
            socket.send(encoded, (error?: Error) => {
                if (error) finish(error);
            });
        }).catch(error => finish(error));
    });
}

// ============ 消息处理 ============
function handleMessage(data: RawData | Uint8Array | ArrayBuffer): void {
    try {
        const buf = toBuffer(data);
        const msg = decodeMessage('GateMessage', buf);
        const meta = asRecord(msg.meta);
        if (Object.keys(meta).length === 0) return;
        lastInboundAt = Date.now();

        if (meta.server_seq) {
            const seq = toNum(meta.server_seq);
            if (seq > serverSeq) serverSeq = seq;
        }

        const msgType = toNum(meta.message_type);

        // Notify
        if (msgType === 3) {
            handleNotify(msg);
            return;
        }

        // Response
        if (msgType === 2) {
            const errorCode = toNum(meta.error_code);
            const clientSeqVal = toNum(meta.client_seq);

            const entry = pendingCallbacks.get(clientSeqVal);
            if (entry) {
                pendingCallbacks.delete(clientSeqVal);
                if (errorCode !== 0) {
                    entry.callback(new GatewayError(meta));
                } else {
                    entry.callback(null, toBuffer(msg.body), meta);
                }
                return;
            }

            if (errorCode !== 0) {
                logWarn('错误', `${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`);
            }
        }
    } catch (err) {
        logWarn('解码', errorMessage(err));
    }
}

// 服务端版本信息校准：登录回复/心跳回复里的 version_info 带推荐/强制版本，
// 提取版本前缀并与本地比较，不同则自动更新（根治"客户端版本过低"被踢）。
function applyServerVersionInfo(versionInfo: unknown): void {
    try {
        const source = asRecord(versionInfo);
        const ver = String(source.version_force || source.version_recommend || '').trim();
        if (!ver) return;
        const prefix = ver.split('_')[0].trim();
        if (!prefix || prefix === getVersionPrefix()) return;
        setClientVersionPrefix(prefix);
        log('系统', `服务端版本信息: ${ver}，已自动校准客户端版本前缀为 ${prefix}`);
        networkEvents.emit('versionPrefixChanged', prefix);
    } catch { }
}

function handleNotify(msg: DataRecord): void {
    const messageBody = toBuffer(msg.body);
    if (messageBody.length === 0) return;
    try {
        const event = decodeMessage('EventMessage', messageBody);
        const type = String(event.message_type || '');
        const eventBody = toBuffer(event.body);

        if (type.includes('ActiviesChangeNotify') || type.includes('ActivitiesChangeNotify')) {
            networkEvents.emit('activitiesChanged');
            return;
        }

        // 被踢下线
        if (type.includes('Kickout')) {
            log('推送', `被踢下线! ${type}`);
            try {
                const notify = decodeMessage('KickoutNotify', eventBody);
                log('推送', `原因: ${String(notify.reason_message || '未知')}`);
                networkEvents.emit('kickout', {
                    type,
                    reason: String(notify.reason_message || '未知'),
                });
            } catch { }
            return;
        }

        // 青蛙等农场级社交事件变化。与乌云不同，它不附着在 LandInfo 上。
        if (type.includes('FarmSocialEventsNotify')) {
            try {
                const notify = decodeMessage('FarmSocialEventsNotify', eventBody);
                const hostGid = toNum(notify.host_gid);
                if (hostGid === userState.gid || hostGid === 0) {
                    networkEvents.emit('farmSocialEventsChanged', notify.social_events || []);
                }
            } catch { }
            return;
        }

        // 土地状态变化 (被放虫/放草/偷菜等)
        if (type.includes('LandsNotify')) {
            try {
                const notify = decodeMessage('LandsNotify', eventBody);
                const hostGid = toNum(notify.host_gid);
                const lands = Array.isArray(notify.lands) ? notify.lands : [];
                if (lands.length > 0) {
                    // 如果是自己的农场，触发事件
                    if (hostGid === userState.gid || hostGid === 0) {
                        networkEvents.emit('landsChanged', lands);
                    }
                }
            } catch { }
            return;
        }

        if (type.includes('PendingGiftCountNotify')) {
            try {
                const notify = decodeMessage('PendingGiftCountNotify', eventBody);
                networkEvents.emit('dogSkillGiftPending', Math.max(0, toNum(notify.count)));
            } catch { }
            return;
        }

        if (type.includes('NewProtectLogNotify')) {
            networkEvents.emit('dogProtectLogChanged');
            return;
        }

        // 物品变化通知 (经验/金币等)
        if (type.includes('ItemNotify')) {
            try {
                const notify = decodeMessage('ItemNotify', eventBody);
                const items = recordArray(notify.items);
                for (const itemChg of items) {
                    const item = asRecord(itemChg.item);
                    if (Object.keys(item).length === 0) continue;
                    const id = toNum(item.id);
                    const count = toNum(item.count);
                    const delta = toNum(itemChg.delta);
                    
                    // 仅使用 ID=1101 作为经验值标准
                    if (id === 1101) {
                        // 优先使用总量；若仅有 delta 也可累加
                        if (count > 0) userState.exp = count;
                        else if (delta !== 0) userState.exp = Math.max(0, Number(userState.exp || 0) + delta);
                        // 这里调用 updateStatusLevel 会触发 status.js -> worker.js -> stats.js 的更新流程
                        updateStatusLevel(userState.level, userState.exp);
                    } else if (id === 1 || id === 1001) {
                        // 金币通知有时只有 delta 没有总量，避免把未提供总量误当 0 覆盖
                        if (count > 0) {
                            userState.gold = count;
                        } else if (delta !== 0) {
                            userState.gold = Math.max(0, Number(userState.gold || 0) + delta);
                        }
                        updateStatusGold(userState.gold);
                    } else if (id === 1002) {
                        // 点券
                        if (count > 0) {
                            userState.coupon = count;
                        } else if (delta !== 0) {
                            userState.coupon = Math.max(0, Number(userState.coupon || 0) + delta);
                        }
                    } else if (id === 1005) {
                        // 金豆豆
                        if (count > 0) {
                            userState.goldBean = count;
                        } else if (delta !== 0) {
                            userState.goldBean = Math.max(0, Number(userState.goldBean || 0) + delta);
                        }
                    } else if (id === 1004) {
                        if (count > 0) {
                            userState.diamond = count;
                        } else if (delta !== 0) {
                            userState.diamond = Math.max(0, Number(userState.diamond || 0) + delta);
                        }
                    }
                }
            } catch { }
            return;
        }

        // 基本信息变化 (升级等)
        if (type.includes('BasicNotify')) {
            try {
                const notify = decodeMessage('BasicNotify', eventBody);
                const basic = asRecord(notify.basic);
                if (Object.keys(basic).length > 0) {
                    const oldLevel = userState.level;
                    if (hasOwn(basic, 'level')) {
                        const nextLevel = toNum(basic.level);
                        if (Number.isFinite(nextLevel) && nextLevel > 0) userState.level = nextLevel;
                    }
                    let shouldUpdateGoldView = false;
                    if (hasOwn(basic, 'gold')) {
                        const nextGold = toNum(basic.gold);
                        if (Number.isFinite(nextGold) && nextGold >= 0) {
                            userState.gold = nextGold;
                            shouldUpdateGoldView = true;
                        }
                    }
                    if (hasOwn(basic, 'exp')) {
                        const exp = toNum(basic.exp);
                        if (Number.isFinite(exp) && exp >= 0) {
                            userState.exp = exp;
                            updateStatusLevel(userState.level, exp);
                        }
                    }
                    if (shouldUpdateGoldView) {
                        updateStatusGold(userState.gold);
                    }
                    if (userState.level !== oldLevel) {
                        recordOperation('levelUp', 1);
                    }
                }
            } catch { }
            return;
        }

        // 好友申请通知 (微信同玩)
        if (type.includes('FriendApplicationReceivedNotify')) {
            try {
                const notify = decodeMessage('FriendApplicationReceivedNotify', eventBody);
                const applications = Array.isArray(notify.applications) ? notify.applications : [];
                if (applications.length > 0) {
                    networkEvents.emit('friendApplicationReceived', applications);
                }
            } catch { }
            return;
        }

        // 好友添加成功通知
        if (type.includes('FriendAddedNotify')) {
            try {
                const notify = decodeMessage('FriendAddedNotify', eventBody);
                const friends = recordArray(notify.friends);
                if (friends.length > 0) {
                    const names = friends.map(f => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
                    log('好友', `新好友: ${names}`);
                }
            } catch { }
            return;
        }

        // 商品解锁通知 (升级后解锁新种子等)
        if (type.includes('GoodsUnlockNotify')) {
            try {
                const notify = decodeMessage('GoodsUnlockNotify', eventBody);
                const goods = Array.isArray(notify.goods_list) ? notify.goods_list : [];
                if (goods.length > 0) {
                    networkEvents.emit('goodsUnlockNotify', goods);
                }
            } catch { }
            return;
        }

        // 任务状态变化通知
        if (type.includes('TaskInfoNotify')) {
            try {
                const notify = decodeMessage('TaskInfoNotify', eventBody);
                if (notify.task_info) {
                    networkEvents.emit('taskInfoNotify', notify.task_info);
                }
            } catch { }
            return;
        }

        // 战令（千星游记）进度变化通知：推送驱动自动领取
        if (type.includes('BattlePassChangeNotify')) {
            try {
                const notify = decodeMessage('BattlePassChangeNotify', eventBody);
                networkEvents.emit('battlePassNotify', notify.pass);
            } catch { }
            return;
        }

        // 神秘商人出现：推送携带完整限时商品，交给 Worker 按账号配置决定是否购买。
        if (type.includes('MysteryShopNotify')) {
            try {
                const notify = decodeMessage('MysteryShopNotify', eventBody);
                networkEvents.emit('mysteryShopNotify', notify);
            } catch { }
            return;
        }

        // 红点类通知（图鉴/头像框/成就等）：界面状态提示，bot 无需响应，静默识别避免刷"未处理"日志
        if (type.includes('RedDotNotify')) {
            return;
        }

        // 商城需求通知：空信号（无数据），触发主动探测商城各 slot 定位神秘商人/活动商店
        if (type.includes('NeedNotify')) {
            networkEvents.emit('mallNeedNotify');
            return;
        }

        // 互动（访客）新记录通知：访客功能已有每日同步，无需即时响应
        if (type.includes('InteractNewRecordNotify')) {
            return;
        }

        // 物品每日使用次数与充值信息均由对应页面/任务主动查询，推送仅用于客户端界面刷新。
        if (type.includes('ItemUseDailyNotify') || type.includes('RechargeInfoNotify')) {
            return;
        }

        // 其他未处理的推送类型（新协议信号，开发调试用，默认被日志页过滤）
        const gid = toNum((getUserState() || {}).gid) || '';
        log('推送', `未处理类型: ${type}`, { module: 'push', event: 'unhandled_push', type, gid, dev: true });
    } catch (e) {
        logWarn('推送', `解码失败: ${errorMessage(e)}`);
    }
}

// ============ 登录 ============
async function sendLogin(
    revision: number,
    socket: WebSocketLike,
    onLoginSuccess: LoginSuccessCallback | null = null,
): Promise<void> {
    const body = encodeMessage('LoginRequest', {
        sharer_id: toLong(0),
        sharer_open_id: '',
        device_info: {
            client_version: getClientVersion(),
            sys_software: 'iOS 26.2.1',
            network: 'wifi',
            memory: '7672',
            device_id: 'iPhone X<iPhone18,3>',
        },
        share_cfg_id: toLong(0),
        scene_id: '1256',
        report_data: {
            callback: '', cd_extend_info: '', click_id: '', clue_token: '',
            minigame_channel: 'other', minigame_platid: 2, req_id: '', trackid: '',
        },
    });

    try {
        const { body: replyBody } = await sendMsgAsync(
            'gamepb.userpb.UserService',
            'Login',
            body,
            { timeoutMs: LOGIN_TIMEOUT_MS, category: 'control' },
        );
        if (revision !== connectionRevision || socket !== ws) return;

        const reply = decodeMessage('LoginReply', toBuffer(replyBody));
        const basic = asRecord(reply.basic);
        const gid = toNum(basic.gid);
        if (gid <= 0) throw new Error('登录回包缺少有效账号信息');

        applyServerVersionInfo(reply.version_info);
        clearWsErrorState();
        userState.gid = gid;
        userState.name = String(basic.name || '未知');
        userState.level = toNum(basic.level);
        userState.gold = toNum(basic.gold);
        userState.exp = toNum(basic.exp);

        updateStatusFromLogin({
            name: userState.name,
            level: userState.level,
            gold: userState.gold,
            exp: userState.exp,
        });

        log('系统', `登录成功: ${userState.name} (Lv${userState.level})`);

        console.warn('');
        console.warn('========== 登录成功 ==========');
        console.warn(`  GID:    ${userState.gid}`);
        console.warn(`  昵称:   ${userState.name}`);
        console.warn(`  等级:   ${userState.level}`);
        console.warn(`  金币:   ${userState.gold}`);
        if (reply.time_now_millis) {
            syncServerTime(toNum(reply.time_now_millis));
            console.warn(`  时间:   ${new Date(toNum(reply.time_now_millis)).toLocaleString()}`);
        }
        console.warn('===============================');
        console.warn('');

        userState.openid = String(basic.open_id || '').trim();
        let aceReady = true;
        if (userState.openid) {
            try {
                await cryptoWasm.bindUser(userState.openid);
                const initTokenLength = gatewayTokens.stageInitToken(cryptoWasm.getEncryptedInitInfo());
                if (initTokenLength > 0) {
                    log('ACE', `TSDK 初始化凭据已就绪: ${initTokenLength} 字符，将随下一条请求发送`);
                }
            } catch (aceError) {
                aceReady = false;
                gatewayTokens.clear();
                logWarn('ACE', `TSDK 用户绑定失败，已继续完成账号登录: ${errorMessage(aceError)}`);
            }
        }
        if (revision !== connectionRevision || socket !== ws) return;
        if (aceReady) startAceRuntime(sendMsgAsync);

        reconnectAttempt = 0;
        startHeartbeat();
        setConnectionPhase('ready', '登录认证完成');
        if (onLoginSuccess) {
            Promise.resolve(onLoginSuccess()).catch((error: unknown) => {
                logWarn('系统', `登录后初始化失败: ${errorMessage(error)}`, {
                    module: 'system', event: 'login_initialization', result: 'error',
                });
            });
        }
    } catch (error) {
        if (revision !== connectionRevision || socket !== ws) return;
        const message = errorMessage(error);
        logWarn('登录', `失败: ${message}`, {
            module: 'network', event: 'login_failed', result: 'error', phase: 'authenticating',
        });
        if (error instanceof GatewayError) {
            log('系统', '账号验证失败，即将停止运行...');
            networkScheduler.setTimeoutTask('login_error_exit', 1000, () => process.exit(0));
            return;
        }
        recoverConnection(`登录失败: ${message}`);
    }
}

// ============ 心跳 ============
let heartbeatInFlight = false;
const HEARTBEAT_TIMEOUT = 20000;
let heartbeatMissCount = 0;

function startHeartbeat(): void {
    networkScheduler.clear('heartbeat_interval');
    lastInboundAt = Date.now();
    heartbeatInFlight = false;
    heartbeatMissCount = 0;

    networkScheduler.setIntervalTask('heartbeat_interval', CONFIG.heartbeatInterval, () => {
        if (!userState.gid) return;

        if (heartbeatInFlight) return;

        const body = encodeMessage('HeartbeatRequest', {
            gid: toLong(userState.gid),
            client_version: getClientVersion(),
        });
        heartbeatInFlight = true;
        sendMsgAsync('gamepb.userpb.UserService', 'Heartbeat', body, {
            timeoutMs: HEARTBEAT_TIMEOUT,
            category: 'control',
        }).then(({ body: replyBody }) => {
            heartbeatMissCount = 0;
            try {
                const reply = decodeMessage('HeartbeatReply', replyBody);
                applyServerVersionInfo(reply.version_info);
                if (reply.server_time) syncServerTime(toNum(reply.server_time));
            } catch { }
        }).catch((error: unknown) => {
            const requestError = asRecord(error);
            const wasSent = Number(requestError.sentAt) > 0;
            const noInboundSinceSend = lastInboundAt <= Number(requestError.sentAt);
            if (requestError.code === 'REQUEST_TIMEOUT' && wasSent && noInboundSinceSend) {
                heartbeatMissCount += 1;
                const inboundSilenceMs = Math.max(0, Date.now() - lastInboundAt);
                logWarn('心跳', `心跳未响应 (${heartbeatMissCount}/${MAX_HEARTBEAT_MISSES})，${Math.round(inboundSilenceMs / 1000)}s 无入站消息 (${requestPressureDetails()})`);
                if (shouldReconnectForHeartbeat(heartbeatMissCount, inboundSilenceMs)) {
                    logWarn('心跳', '连续心跳超时且连接无入站数据，开始重连');
                    recoverConnection('连续心跳超时');
                }
            }
        }).finally(() => {
            heartbeatInFlight = false;
        });
    });
}

// ============ WebSocket 连接 ============
let savedLoginCallback: LoginSuccessCallback | null = null;
let savedCode: string | null = null;
// 连接被拒（code 过期）时跳过自动重连，等待 worker 刷新 code 后手动重连
let skipAutoReconnect = false;

function scheduleReconnect(reason: string): void {
    if (!savedCode) return;
    reconnectAttempt += 1;
    const delayMs = computeReconnectDelayMs(reconnectAttempt);
    setConnectionPhase('backoff', `${reason}，${Math.ceil(delayMs / 1000)} 秒后重试`);
    networkScheduler.setTimeoutTask('auto_reconnect', delayMs, () => {
        log('系统', `[WS] 尝试自动重连（第 ${reconnectAttempt} 次）...`, {
            module: 'network', event: 'auto_reconnect', result: 'attempt', reconnectAttempt,
        });
        reconnect(null);
    });
}

function closeCurrentSocket(): void {
    const socket = ws;
    ws = null;
    if (!socket) return;
    socket.removeAllListeners();
    try { socket.close(); } catch { }
}

function recoverConnection(reason: string): void {
    cleanup(reason);
    closeCurrentSocket();
    scheduleReconnect(reason);
}

function connect(code: unknown, onLoginSuccess: LoginSuccessCallback | null = null): void {
    connectionRevision += 1;
    const revision = connectionRevision;
    savedLoginCallback = onLoginSuccess || null;
    if (code) savedCode = String(code);
    resetConnectionProtocolState();
    userState.gid = 0;
    setConnectionPhase('connecting', '建立 WebSocket');
    const url = `${CONFIG.serverUrl}?platform=${CONFIG.platform}&os=${CONFIG.os}&ver=${getClientVersion()}&code=${savedCode}&openID=`;

    let socket: WebSocketLike;
    try {
        socket = new WebSocket(url, {
            handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13)',
                'Origin': 'https://gate-obt.nqf.qq.com',
            },
        });
    } catch (error) {
        const message = errorMessage(error);
        setConnectionPhase('disconnected', `创建连接失败: ${message}`);
        scheduleReconnect(`创建连接失败: ${message}`);
        return;
    }

    ws = socket;
    socket.binaryType = 'arraybuffer';

    socket.on('open', () => {
        if (revision !== connectionRevision || socket !== ws) return;
        lastInboundAt = Date.now();
        setConnectionPhase('authenticating', 'WebSocket 已连接');
        void sendLogin(revision, socket, onLoginSuccess);
    });

    socket.on('message', (data: RawData) => {
        if (revision !== connectionRevision || socket !== ws) return;
        handleMessage(data);
    });

    socket.on('close', (code: number, _reason: Buffer) => {
        if (revision !== connectionRevision || socket !== ws) return;
        console.warn(`[WS] 连接关闭 (code=${code})`);
        cleanup(`连接关闭 code=${code}`);
        if (ws === socket) ws = null;
        // 连接被拒（400，code 过期）：跳过自动重连，等 worker 刷新 code 后手动重连
        if (skipAutoReconnect) {
            skipAutoReconnect = false;
            setConnectionPhase('reauth-required', '登录 Code 已失效');
            return;
        }
        scheduleReconnect(`连接关闭 code=${code}`);
    });

    socket.on('error', (err: Error) => {
        if (revision !== connectionRevision || socket !== ws) return;
        const message = err && err.message ? String(err.message) : '';
        logWarn('系统', `[WS] 错误: ${message}`);
        const match = message.match(/Unexpected server response:\s*(\d+)/i);
        if (match) {
            const code = Number.parseInt(match[1], 10) || 0;
            if (code) {
                setWsErrorState(code, message);
                networkEvents.emit('ws_error', { code, message });
                // 400 = 登录 code 过期：通知 worker 刷新 code，跳过自动重连（旧 code 重连会死循环）
                if (code === 400) {
                    skipAutoReconnect = true;
                    networkEvents.emit('ws_code_rejected');
                    cleanup('登录 Code 已失效');
                    closeCurrentSocket();
                    setConnectionPhase('reauth-required', '登录 Code 已失效');
                    return;
                }
            }
        }
        recoverConnection(`WebSocket 错误: ${message || '未知错误'}`);
    });
}

function cleanup(reason = '网络清理'): void {
    connectionRevision += 1;
    heartbeatInFlight = false;
    heartbeatMissCount = 0;
    userState.gid = 0;
    gatewayTokens.clear();
    rejectAllPendingRequests(`请求已中断: ${reason}`);
    networkScheduler.clearAll();
    stopAceRuntime(true);
    setConnectionPhase('disconnected', reason);
}

function reconnect(newCode: unknown): void {
    cleanup('主动重连');
    closeCurrentSocket();
    skipAutoReconnect = false;
    connect(newCode || savedCode, savedLoginCallback);
}

function getWs(): WebSocketLike | null { return ws; }
function getConnectionState(): ConnectionStateSnapshot { return { ...connectionState }; }

export {
    cleanup,
    connect,
    GatewayError,
    getConnectionState,
    getUserState,
    getWs,
    getWsErrorState,
    networkEvents,
    reconnect,
    sendMsgAsync,
};
