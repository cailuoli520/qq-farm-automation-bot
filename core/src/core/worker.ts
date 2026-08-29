import process from 'node:process';
import type { MasterToWorkerMessage, WorkerToMasterMessage, WxCredentialAction } from '../types/ipc';
import type { WorkerBattlePassPushRuntime } from '../runtime/worker-battle-pass';
import type { WorkerMysteryShopRuntime } from '../runtime/worker-mystery-shop';
import type { WorkerPetGiftRuntime } from '../runtime/worker-pet-gifts';
import type { WorkerRainPoetryRuntime } from '../runtime/worker-rain-poetry';
import { assertNever } from '../types/ipc';
import { createWorkerApiHandler, createWorkerApiMethods } from '../runtime/worker-api';
import { createWorkerAutomationScheduler } from '../runtime/worker-automation-scheduler';
import { createWorkerDailyRoutineScheduler } from '../runtime/worker-daily-routine-scheduler';
import { getDailyGiftOverview } from '../runtime/worker-daily-gifts';
import { createWorkerStatusSynchronizer } from '../runtime/worker-status-sync';
import { createWorkerRainPoetryRuntime } from '../runtime/worker-rain-poetry';
import { clearFriendWeatherCache, recordFriendWeatherVisit } from '../services/friend-weather-cache';
import { registerFriendVisitObserver } from '../services/friend-visit';
/**
 * 子进程 Worker - 负责运行单个账号的挂机逻辑
 */
const { parentPort, workerData } = require('node:worker_threads');
const { CONFIG } = require('../config/config');
const { getAutomation, getConfigSnapshot, applyConfigSnapshot } = require('../models/store');
const { checkAndClaimEmails } = require('../services/email');
const { checkFarm, startFarmCheckLoop, stopFarmCheckLoop, refreshFarmCheckLoop, runFertilizerByConfig } = require('../services/farm');
const { checkFriends, startFriendCheckLoop, stopFriendCheckLoop, refreshFriendCheckLoop, runBadOncePerDay, isHelpExpLimitReached } = require('../services/friend');
const { getBeijingDateKey } = require('../services/friend-operation-limits');
const { processInviteCodes } = require('../services/invite');
const { buyFreeGifts } = require('../services/mall');
const { performDailyMonthCardGift } = require('../services/monthcard');
const { getDiamondBalance } = require('../services/pay');
const { performDailyVipGift } = require('../services/qqvip');
const { createScheduler } = require('../services/scheduler');
const { stopAceRuntime } = require('../services/ace');
const { performDailyShare } = require('../services/share');
const { resetSessionGains, recordOperation, initStatsWithPersistence, saveStats } = require('../services/stats');
const { initStatusBar, setStatusPlatform } = require('../services/status');
const { setRecordGoldExpHook } = require('../services/status');
const { cleanupTaskSystem, checkAndClaimTasks, initTaskSystem } = require('../services/task');
const { sellAllFruits, getBag, getBagItems, openFertilizerGiftPacksSilently } = require('../services/warehouse');
const { connect, reconnect, cleanup, getConnectionState, getUserState, getWs, networkEvents } = require('../utils/network');
const { setClientVersionPrefix } = require('../config/config');
const { createWorkerBattlePassPushRuntime } = require('../runtime/worker-battle-pass');
const { createWorkerMysteryShopRuntime } = require('../runtime/worker-mystery-shop');
const { createWorkerPetGiftRuntime } = require('../runtime/worker-pet-gifts');
const { flushWorkerMessage, sendWorkerMessage } = require('../runtime/worker-channel');
const { loadProto } = require('../utils/proto');
const { setLogHook, log, toNum } = require('../utils/utils');

type DynamicRecord = Record<string, any>;

interface CredentialResult {
    Success?: boolean;
    Data?: { code?: string };
    Message?: string;
}

interface PendingCredentialRequest {
    resolve: (value: CredentialResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const MASTER_MESSAGE_TYPES = new Set<MasterToWorkerMessage['type']>([
    'ping',
    'start',
    'stop',
    'config_sync',
    'api_call',
    'wx_credential_response',
]);

function isMasterToWorkerMessage(value: unknown): value is MasterToWorkerMessage {
    if (!value || typeof value !== 'object') return false;
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string' && MASTER_MESSAGE_TYPES.has(type as MasterToWorkerMessage['type']);
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

if (parentPort && workerData && workerData.accountId && !process.env.FARM_ACCOUNT_ID) {
    process.env.FARM_ACCOUNT_ID = String(workerData.accountId);
}

// 应用主进程传入的版本前缀（服务端 version_info 校准结果，跨重启持久化）
if (process.env.FARM_VERSION_PREFIX) setClientVersionPrefix(process.env.FARM_VERSION_PREFIX);
if (workerData && workerData.versionPrefix) setClientVersionPrefix(workerData.versionPrefix);

// 微信 code 刷新连续失败计数（登录 code 一次性，旧 code 重连会 400 死循环，限次后停止等用户重新扫码）
let codeRefreshFailCount = 0;
let workerLifecycleRevision = 0;
let masterCredentialRequestId = 0;
const masterCredentialRequests = new Map<number, PendingCredentialRequest>();
let isRunning = false;
let loginReady = false;
let appliedConfigRevision = 0;
let onSellGain: ((deltaGold: unknown) => void) | null = null;
let onFarmHarvested: (() => Promise<void>) | null = null;
let battlePassPushRuntime: WorkerBattlePassPushRuntime | null = null;
let mysteryShopRuntime: WorkerMysteryShopRuntime | null = null;
let petGiftRuntime: WorkerPetGiftRuntime | null = null;
let rainPoetryRuntime: WorkerRainPoetryRuntime | null = null;
let unregisterFriendWeatherObserver: (() => void) | null = null;
let harvestSellRunning = false;
let onWsError: ((payload: DynamicRecord) => void) | null = null;
let onConnectionStateChanged: ((payload: DynamicRecord) => void) | null = null;
let wsErrorHandledAt = 0;
let reauthRequiredNotified = false;
let workerStartupPromise: Promise<void> | null = null;
let initialLoginInitialized = false;
const workerScheduler = createScheduler('worker');

function isGatewayReady(): boolean {
    return loginReady && getConnectionState().ready === true;
}

const automationScheduler = createWorkerAutomationScheduler({
    checkAndClaimEmails,
    checkAndClaimTasks,
    checkFarm,
    checkFriends,
    config: CONFIG,
    getAutomation,
    isHelpExpLimitReached,
    isLoginReady: isGatewayReady,
    log,
    openFertilizerGiftPacksSilently,
    scheduler: workerScheduler,
});
const dailyRoutineScheduler = createWorkerDailyRoutineScheduler({
    getDateKey: getBeijingDateKey,
    isLoginReady: isGatewayReady,
    runStartupRoutines: () => runDailyRoutines(true),
    runCrossDayRoutines: async () => {
        await runDailyRoutines(true);
        void rainPoetryRuntime?.checkNow('cross-day');
        await runBadOncePerDay();
    },
    scheduler: workerScheduler,
});

function sendToMaster(payload: WorkerToMasterMessage): void {
    sendWorkerMessage(process, parentPort, payload);
}

const syncStatus = createWorkerStatusSynchronizer({
    canSend: () => !!(process.send || parentPort),
    getConfigRevision: () => appliedConfigRevision,
    getLoginReady: () => loginReady,
    getScheduleTimes: automationScheduler.getScheduleTimes,
    sendToMaster,
});

function onMasterMessage(handler: (message: MasterToWorkerMessage) => void | Promise<void>): void {
    const receive = (message: unknown): void => {
        if (!isMasterToWorkerMessage(message)) {
            sendToMaster({ type: 'error', error: '收到无效主进程消息' });
            return;
        }
        void handler(message);
    };
    if (process.send) {
        process.on('message', receive);
    }
    if (parentPort) {
        parentPort.on('message', receive);
    }
}

function requestMasterCredential(action: WxCredentialAction, timeoutMs = 120000): Promise<CredentialResult> {
    const id = ++masterCredentialRequestId;
    return new Promise<CredentialResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            masterCredentialRequests.delete(id);
            reject(new Error('主进程微信凭证操作超时'));
        }, timeoutMs);
        masterCredentialRequests.set(id, { resolve, reject, timer });
        sendToMaster({ type: 'wx_credential_request', id, action });
    });
}

function cleanupWorkerResources(): void {
    workerLifecycleRevision += 1;
    isRunning = false;
    loginReady = false;
    initialLoginInitialized = false;
    try { saveStats(); } catch {}
    try { automationScheduler.stop(); } catch {}
    try { dailyRoutineScheduler.stop(); } catch {}
    try { stopFarmCheckLoop(); } catch {}
    try { stopFriendCheckLoop(); } catch {}
    try { cleanupTaskSystem(); } catch {}
    try { battlePassPushRuntime?.stop(); } catch {}
    battlePassPushRuntime = null;
    try { mysteryShopRuntime?.stop(); } catch {}
    mysteryShopRuntime = null;
    try { petGiftRuntime?.stop(); } catch {}
    petGiftRuntime = null;
    try { rainPoetryRuntime?.stop(); } catch {}
    rainPoetryRuntime = null;
    try { unregisterFriendWeatherObserver?.(); } catch {}
    unregisterFriendWeatherObserver = null;
    clearFriendWeatherCache();
    if (onConnectionStateChanged) {
        networkEvents.off('connectionStateChanged', onConnectionStateChanged);
        onConnectionStateChanged = null;
    }
    try { stopAceRuntime(true); } catch {}
    try { cleanup('worker exit'); } catch {}
    try { workerScheduler.clearAll(); } catch {}
    for (const pending of masterCredentialRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Worker 已停止'));
    }
    masterCredentialRequests.clear();
    try {
        const ws = getWs();
        if (ws) {
            ws.removeAllListeners();
            if (typeof ws.terminate === 'function') ws.terminate();
            else ws.close();
        }
    } catch {}
}

function exitWorker(code = 0): void {
    cleanupWorkerResources();
    if (parentPort) {
        try {
            parentPort.close();
        } catch {}
        return;
    }
    process.exit(code);
}

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

function formatLocalDateTime24(date: Date = new Date()): string {
    const d = date instanceof Date ? date : new Date();
    const y = d.getFullYear();
    const m = pad2(d.getMonth() + 1);
    const day = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mm = pad2(d.getMinutes());
    const ss = pad2(d.getSeconds());
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
}

// 捕获日志发送给主进程
setLogHook((tag: string, msg: string, isWarn: boolean, meta: DynamicRecord) => {
    sendToMaster({
        type: 'log',
        data: {
            time: formatLocalDateTime24(new Date()),
            tag,
            msg,
            isWarn,
            level: isWarn ? 'warn' : 'info',
            meta: meta || {},
        }
    });
});

// 捕获金币经验变化
setRecordGoldExpHook((gold: number, exp: number) => {
    // 更新内部统计
    const { recordGoldExp } = require('../services/stats');
    recordGoldExp(gold, exp);

    // 发送给主进程
    sendToMaster({ type: 'stat_update', data: { gold, exp } });
});

async function notifyReauthRequired(message: string): Promise<void> {
    if (reauthRequiredNotified) return;
    reauthRequiredNotified = true;
    await flushWorkerMessage(process, parentPort, {
        type: 'reauth_required',
        code: 400,
        message,
    });
}

function isDailyRoutineEnabled(_auto: unknown): boolean {
    // 每日任务默认启用，不再检查开关
    return true;
}

async function runDailyRoutines(force = false): Promise<void> {
    if (!isGatewayReady()) return;
    try {
        // 以下功能默认启用，不再检查开关
        await checkAndClaimEmails(force);
        await performDailyShare(force);
        await performDailyMonthCardGift(force);
        await buyFreeGifts(force);
        await performDailyVipGift(force);
    } catch (e) {
        log('系统', `每日任务调度失败: ${errorMessage(e)}`, { module: 'system', event: '每日任务', result: 'error' });
    }
}

function normalizeIntervalRangeSec(minSec: unknown, maxSec: unknown, fallbackSec: unknown): { min: number; max: number } {
    const fallback = Math.max(1, Number.parseInt(String(fallbackSec || ''), 10) || 1);
    let min = Math.max(1, Number.parseInt(String(minSec || ''), 10) || fallback);
    let max = Math.max(1, Number.parseInt(String(maxSec || ''), 10) || fallback);
    if (min > max) [min, max] = [max, min];
    return { min, max };
}

function applyIntervalsToRuntime(intervals: unknown): void {
    const data: DynamicRecord = (intervals && typeof intervals === 'object') ? intervals as DynamicRecord : {};

    const farmLegacy = Math.max(1, Number.parseInt(data.farm, 10) || 2);
    const farmRange = normalizeIntervalRangeSec(data.farmMin, data.farmMax, farmLegacy);
    CONFIG.farmCheckIntervalMin = farmRange.min * 1000;
    CONFIG.farmCheckIntervalMax = farmRange.max * 1000;
    CONFIG.farmCheckInterval = CONFIG.farmCheckIntervalMin;

    // 帮助和偷菜的独立间隔
    const helpRange = normalizeIntervalRangeSec(data.helpMin, data.helpMax, 10);
    CONFIG.helpCheckIntervalMin = helpRange.min * 1000;
    CONFIG.helpCheckIntervalMax = helpRange.max * 1000;

    const stealRange = normalizeIntervalRangeSec(data.stealMin, data.stealMax, 10);
    CONFIG.stealCheckIntervalMin = stealRange.min * 1000;
    CONFIG.stealCheckIntervalMax = stealRange.max * 1000;
}

function applyRuntimeConfig(snapshot: DynamicRecord, syncNow = false): void {
    const prevAuto = getAutomation();
    const accountId = process.env.FARM_ACCOUNT_ID || '';
    applyConfigSnapshot(snapshot || {}, { persist: false, accountId });
    const rev = Number((snapshot || {}).__revision || 0);
    if (rev > 0) appliedConfigRevision = rev;

    // 优先使用本次下发的间隔，避免 worker 内部 store 漂移导致回退默认值
    const incomingIntervals = (snapshot && snapshot.intervals && typeof snapshot.intervals === 'object')
        ? snapshot.intervals
        : null;
    if (incomingIntervals) {
        applyIntervalsToRuntime(incomingIntervals);
    }

    if (isGatewayReady()) {
        refreshFarmCheckLoop(200);
        refreshFriendCheckLoop(200);
        automationScheduler.reset();
        automationScheduler.scheduleNext();

        // 保存设置后若“自动处理日常”开启，则立即执行一次
        const hasAutomationPayload = !!(snapshot && snapshot.automation && typeof snapshot.automation === 'object');
        if (hasAutomationPayload) {
            const nextAuto = getAutomation();
            const wasEnabled = isDailyRoutineEnabled(prevAuto);
            const nowEnabled = isDailyRoutineEnabled(nextAuto);
            if (!wasEnabled && nowEnabled) {
                // 保存设置时 /api/automation 可能触发多次 config_sync，这里做防抖且仅关->开触发
                workerScheduler.setTimeoutTask('daily_routine_immediate', 400, () => {
                    runDailyRoutines(true).catch(() => null);
                });
            }

            const prevFertilizerMode = String(prevAuto && prevAuto.fertilizer ? prevAuto.fertilizer : '').toLowerCase();
            const nextFertilizerMode = String(nextAuto && nextAuto.fertilizer ? nextAuto.fertilizer : '').toLowerCase();
            const fertilizerChanged = prevFertilizerMode !== nextFertilizerMode;
            // if (fertilizerChanged && (nextFertilizerMode === 'both' || nextFertilizerMode === 'organic')) {
            if (fertilizerChanged && (nextFertilizerMode === 'both' || nextFertilizerMode === 'organic' || nextFertilizerMode === 'smart')) {
                // 保存设置时 /api/automation 可能连续触发多次 config_sync，这里做防抖为一次立即施肥
                workerScheduler.setTimeoutTask('fertilizer_immediate_after_save', 600, async () => {
                    if (!isGatewayReady()) return;
                    try {
                        // await runFertilizerByConfig([]);
                        await runFertilizerByConfig([], { skipNormal: true });
                    } catch (e) {
                        log('施肥', `保存配置后立即施肥失败: ${errorMessage(e)}`, {
                            module: 'farm',
                            event: '施肥',
                            result: 'error',
                        });
                    }
                });
            }

            if (!prevAuto?.mystery_shop_buy && nextAuto?.mystery_shop_buy) {
                workerScheduler.setTimeoutTask('mystery_shop_immediate_after_save', 400, () => {
                    if (!isGatewayReady()) return;
                    mysteryShopRuntime?.checkNow().catch(() => null);
                });
            }

            if (prevAuto?.rain_poetry_auto && !nextAuto?.rain_poetry_auto) {
                rainPoetryRuntime?.stop();
            } else if (!prevAuto?.rain_poetry_auto && nextAuto?.rain_poetry_auto) {
                rainPoetryRuntime?.start();
                workerScheduler.setTimeoutTask('rain_poetry_immediate_after_save', 400, () => {
                    if (!isGatewayReady()) return;
                    rainPoetryRuntime?.checkNow('config-enabled').catch(() => null);
                });
            }
        }
    }

    if (syncNow) syncStatus();
}

const handleApiCall = createWorkerApiHandler(createWorkerApiMethods({
    applyRuntimeConfig,
    getDailyGiftOverview,
}), sendToMaster);

// 接收主进程指令
onMasterMessage(async (msg) => {
    try {
        if (msg.type === 'ping') {
            // 主进程 watchdog 探活：事件循环活着立即回 pong（卡死时收不到）
            sendToMaster({ type: 'pong' });
            return;
        }
        if (msg.type === 'wx_credential_response') {
            const pending = masterCredentialRequests.get(msg.id);
            if (pending) {
                clearTimeout(pending.timer);
                masterCredentialRequests.delete(msg.id);
                if (msg.error) pending.reject(new Error(msg.error));
                else pending.resolve((msg.result && typeof msg.result === 'object' ? msg.result : {}) as CredentialResult);
            }
            return;
        }
        if (msg.type === 'start') {
            const startup = startBot(msg.config);
            workerStartupPromise = startup;
            try {
                await startup;
            } finally {
                if (workerStartupPromise === startup) workerStartupPromise = null;
            }
        } else if (msg.type === 'stop') {
            await stopBot();
        } else if (msg.type === 'api_call') {
            // EventEmitter 不会串行等待异步监听器。主进程在 start 后立即发来的
            // API 调用必须等 Protobuf 初始化完成，否则会访问尚未赋值的消息类型。
            if (workerStartupPromise) await workerStartupPromise;
            await handleApiCall(msg);
        } else if (msg.type === 'config_sync') {
            applyRuntimeConfig(msg.config || {}, true);
        }
        else {
            assertNever(msg);
        }
    } catch (e) {
        sendToMaster({ type: 'error', error: errorMessage(e) });
    }
});

async function startBot(config: Extract<MasterToWorkerMessage, { type: 'start' }>['config']): Promise<void> {
    if (isRunning) return;
    const lifecycleRevision = ++workerLifecycleRevision;
    const isLifecycleActive = () => isRunning && lifecycleRevision === workerLifecycleRevision;
    isRunning = true;
    clearFriendWeatherCache();
    unregisterFriendWeatherObserver?.();
    unregisterFriendWeatherObserver = registerFriendVisitObserver(context => {
        recordFriendWeatherVisit(context);
    });

    const { code, platform } = config;

    CONFIG.platform = platform || 'qq';
    // 注意：间隔配置由 applyIntervalsToRuntime 统一处理，不要在这里覆盖

    await loadProto();
    if (!isLifecycleActive()) return;

    log('系统', '正在连接服务器...');

    // 加载保存的配置
    applyRuntimeConfig(getConfigSnapshot(), false);

    initStatusBar();
    setStatusPlatform(CONFIG.platform);

    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    onWsError = (payload) => {
        if ((Number(payload?.code) || 0) !== 400) return;
        const now = Date.now();
        if (now - wsErrorHandledAt < 4000) return;
        wsErrorHandledAt = now;
        log('系统', '连接被拒绝，可能需要更新 Code');
        sendToMaster({
            type: 'ws_error',
            code: 400,
            message: payload?.message || '',
        });
    };
    networkEvents.on('ws_error', onWsError);
    networkEvents.on('mallNeedNotify', () => {
        // 神秘商人/活动商店已由活动中心（activitypb 星砂商店）覆盖，mallpb 探测冗余，已停用
        // probeMallSlots().catch(() => {});
    });
    networkEvents.on('ws_code_rejected', async () => {
        // 连接被拒（400，登录 code 过期）：刷新微信 code 后重连，避免旧 code 死循环
        try {
            const { getAccounts } = require('../models/store');
            const accountId = String(process.env.FARM_ACCOUNT_ID || '');
            const accounts = typeof getAccounts === 'function' ? getAccounts() : { accounts: [] };
            const acc = (accounts.accounts || []).find((account: DynamicRecord) => String(account.id) === accountId);
            if (!acc || !acc.wxid) {
                await notifyReauthRequired('登录 Code 已失效，且当前账号缺少可用于自动刷新的微信凭证');
                log('系统', '刷新 code 失败：找不到当前账号 wxid，5 秒后用旧 code 重连');
                workerScheduler.setTimeoutTask('season_ws_retry_old_code', 5000, () => reconnect(null));
                return;
            }
            const refresh = await requestMasterCredential('refresh_code');
            if (!isRunning) return;
            if (refresh.Success && refresh.Data && refresh.Data.code) {
                codeRefreshFailCount = 0;
                log('系统', `账号 ${acc.name} 登录 code 已刷新，重新连接`, { accountId: String(accountId) });
                reconnect(refresh.Data.code);
            } else {
                codeRefreshFailCount += 1;
                if (codeRefreshFailCount >= 3) {
                    await notifyReauthRequired(refresh.Message || '微信登录凭证已失效');
                    log('系统', `账号 ${acc.name} 刷新 code 连续失败 ${codeRefreshFailCount} 次（${refresh.Message || '未知'}），停止重连，请重新扫码登录后手动启动`, { accountId: String(accountId) });
                    exitWorker(0);
                    return;
                }
                log('系统', `账号 ${acc.name} 刷新 code 失败: ${refresh.Message || '未知'}（第 ${codeRefreshFailCount}/3 次），30 秒后用旧 code 重连`, { accountId: String(accountId) });
                workerScheduler.setTimeoutTask('season_ws_retry_old_code', 30000, () => reconnect(null));
            }
        } catch (e) {
            if (!isRunning) return;
            codeRefreshFailCount += 1;
            const reason = errorMessage(e);
            if (codeRefreshFailCount >= 3) {
                await notifyReauthRequired(reason || '微信登录凭证刷新异常');
                log('系统', `刷新 code 异常连续 ${codeRefreshFailCount} 次（${reason}），停止重连，请重新扫码登录后手动启动`, { accountId: String(process.env.FARM_ACCOUNT_ID || '') });
                exitWorker(0);
                return;
            }
            log('系统', `刷新 code 异常: ${reason}（第 ${codeRefreshFailCount}/3 次），30 秒后用旧 code 重连`, { accountId: String(process.env.FARM_ACCOUNT_ID || '') });
            workerScheduler.setTimeoutTask('season_ws_retry_old_code', 30000, () => reconnect(null));
        }
    });

    networkEvents.on('kickout', onKickout);

    const mysteryRuntime: WorkerMysteryShopRuntime = mysteryShopRuntime
        || createWorkerMysteryShopRuntime({
            events: networkEvents,
            getAutomation,
            isConnectionReady: isGatewayReady,
            isLifecycleActive,
            log,
            getCurrencyBalance: (currencyId: string) => {
                const state = getUserState();
                if (currencyId === '1' || currencyId === '1001') return state.gold;
                if (currencyId === '1002') return state.coupon;
                if (currencyId === '1004') return state.diamond;
                if (currencyId === '1005') return state.goldBean;
                return null;
            },
            notify: (title: string, content: string) => {
                sendToMaster({ type: 'push_notify', title, content });
            },
            service: require('../services/mystery-shop'),
        });
    mysteryShopRuntime = mysteryRuntime;

    const rainRuntime: WorkerRainPoetryRuntime = rainPoetryRuntime
        || createWorkerRainPoetryRuntime({
            getAutomation,
            isConnectionReady: isGatewayReady,
            isLifecycleActive,
            log,
            scheduler: workerScheduler,
            service: require('../services/activity'),
        });
    rainPoetryRuntime = rainRuntime;

    if (onConnectionStateChanged) {
        networkEvents.off('connectionStateChanged', onConnectionStateChanged);
    }
    onConnectionStateChanged = (state) => {
        if (state?.ready === true) {
            syncStatus();
            return;
        }

        const wasReady = loginReady;
        loginReady = false;
        if (!wasReady) {
            syncStatus();
            return;
        }

        automationScheduler.pause();
        rainPoetryRuntime?.pause();
        mysteryShopRuntime?.pause();
        cleanupTaskSystem();
        stopFarmCheckLoop();
        stopFriendCheckLoop();
        workerScheduler.clear('rain_poetry_login');
        workerScheduler.clear('bad_daily_once');
        syncStatus();
    };
    networkEvents.on('connectionStateChanged', onConnectionStateChanged);

    // 服务端版本前缀校准结果上报主进程（用于持久化，跨重启生效）
    networkEvents.on('versionPrefixChanged', (prefix: unknown) => {
        sendToMaster({ type: 'version_prefix_update', prefix: String(prefix || '') });
    });

    const onLoginSuccess = async () => {
        const loginRevision = getConnectionState().revision;
        const isCurrentLoginReady = () => isLifecycleActive()
            && getConnectionState().ready === true
            && getConnectionState().revision === loginRevision;
        if (!isCurrentLoginReady()) return;
        const firstLogin = !initialLoginInitialized;
        loginReady = true;
        reauthRequiredNotified = false;
        mysteryShopRuntime?.resume();
        mysteryShopRuntime?.checkNow().catch(() => null);
        if (onSellGain) {
            networkEvents.off('sell', onSellGain);
        }
        onSellGain = (deltaGold) => {
            const delta = Number(deltaGold || 0);
            if (!Number.isFinite(delta) || delta <= 0) return;
            recordOperation('sell', 1);
        };
        networkEvents.on('sell', onSellGain);

        // 任务推送驱动自动领取（TaskInfoNotify 到达即时领，30 秒轮询兜底）
        try {
            initTaskSystem();
        } catch (e) {
            const reason = errorMessage(e);
            log('任务', `任务推送监听初始化失败: ${reason}`, { module: 'task', event: 'push_init_error', error: reason });
        }

        // 战令（千星游记）推送驱动自动领取（BattlePassChangeNotify 到达即领）
        const runtime: WorkerBattlePassPushRuntime = battlePassPushRuntime
            || createWorkerBattlePassPushRuntime({
                events: networkEvents,
                activityService: require('../services/activity'),
                isLifecycleActive,
                log,
            });
        battlePassPushRuntime = runtime;
        runtime.start();

        const giftRuntime: WorkerPetGiftRuntime = petGiftRuntime
            || createWorkerPetGiftRuntime({
                events: networkEvents,
                service: require('../services/pets'),
                isLifecycleActive,
                log,
            });
        petGiftRuntime = giftRuntime;
        giftRuntime.start();
        giftRuntime.checkNow();

        if (onFarmHarvested) {
            networkEvents.off('farmHarvested', onFarmHarvested);
        }
        onFarmHarvested = async () => {
            if (harvestSellRunning) return;
            if (!getAutomation().sell) return;
            harvestSellRunning = true;
            try {
                await sellAllFruits();
            } catch (e) {
                log('仓库', `收获后自动出售失败: ${errorMessage(e)}`, { module: 'warehouse', event: '收获后出售', result: 'error' });
            } finally {
                harvestSellRunning = false;
            }
        };
        networkEvents.on('farmHarvested', onFarmHarvested);

        // 登录后并行初始化背包币种和充值余额。失败值保留为未知，不能伪装成零余额。
        const [bagBalanceResult, diamondBalanceResult] = await Promise.allSettled([
            getBag(),
            getDiamondBalance(),
        ]);
        const state = getUserState();
        if (bagBalanceResult.status === 'fulfilled') {
            const bagReply = bagBalanceResult.value;
            const items = getBagItems(bagReply);
            let coupon = 0;
            let goldBean = 0;
            for (const it of (items || [])) {
                const id = toNum(it && it.id);
                if (id === 1002) coupon = toNum(it.count);
                if (id === 1005) goldBean = toNum(it.count);
            }
            state.coupon = Math.max(0, coupon);
            state.goldBean = Math.max(0, goldBean);
            log('系统', `金豆豆数量: ${state.goldBean}`);
        }
        state.diamond = diamondBalanceResult.status === 'fulfilled'
            ? Math.max(0, Number(diamondBalanceResult.value) || 0)
            : null;
        if (!isCurrentLoginReady()) return;
        if (firstLogin) {
            // 只在 Worker 首次认证成功时建立统计基线，重连不能清空本次会话增量。
            const latest = getUserState();
            const accountId = process.env.FARM_ACCOUNT_ID || '';
            try {
                initStatsWithPersistence(accountId, Number(latest.gold || 0), Number(latest.exp || 0), Number(latest.coupon || 0));
                resetSessionGains();
            } catch (e) {
                log('系统', `会话统计初始化失败: ${errorMessage(e)}`, {
                    module: 'system', event: 'stats_init', result: 'error',
                });
            }

            await processInviteCodes().catch((e: unknown) => {
                log('系统', `邀请码处理失败: ${errorMessage(e)}`, {
                    module: 'system', event: 'invite_init', result: 'error',
                });
            });
            if (!isCurrentLoginReady()) return;
            if (getAutomation().fertilizer_gift) {
                await openFertilizerGiftPacksSilently().catch(() => 0);
            }
            if (!isCurrentLoginReady()) return;
        }

        rainRuntime.resume();
        workerScheduler.setTimeoutTask('rain_poetry_login', 1000, () => {
            if (!isGatewayReady()) return;
            rainRuntime.checkNow(firstLogin ? 'login' : 'reconnect').catch(() => null);
        });

        // 每次认证恢复都重新安排当天任务；任务内部按北京时间做幂等去重。
        // 这样首次启动后 20 秒内掉线也不会永久丢失当天的放虫放草。
        workerScheduler.setTimeoutTask('bad_daily_once', 20000, async () => {
            if (!isGatewayReady()) return;
            try {
                await runBadOncePerDay();
            } catch (e) {
                const reason = errorMessage(e);
                log('好友', `每日放虫放草执行失败: ${reason}`, { module: 'friend', event: '每日放虫放草失败', error: reason });
            }
        });

        if (firstLogin) {
            // 微信凭证定时保活：每 30 分钟主动刷新 loginBuffer + refreshtoken（滚动续期）+ code。
            workerScheduler.setIntervalTask('wx_login_keepalive', 30 * 60 * 1000, async () => {
                if (!isRunning) return;
                try {
                    const accountId = String(process.env.FARM_ACCOUNT_ID || '');
                    const { getAccounts } = require('../models/store');
                    const accounts = typeof getAccounts === 'function' ? getAccounts() : { accounts: [] };
                    const acc = (accounts.accounts || []).find((account: DynamicRecord) => String(account.id) === accountId);
                    if (!acc || !acc.wxid) return;
                    const alive = await requestMasterCredential('keepalive');
                    if (!isRunning) return;
                    if (alive.Success) {
                        log('系统', '微信凭证保活成功（loginBuffer/refreshtoken/code 已续期）', { accountId });
                    }
                } catch (e) {
                    log('系统', `微信凭证保活刷新失败: ${errorMessage(e)}`, { accountId: String(process.env.FARM_ACCOUNT_ID || '') });
                }
            }, { preventOverlap: true });

            // 观星自动点亮：每日星宿奖励含返场作物种子。断线期间只保留计时，不发送业务请求。
            workerScheduler.setIntervalTask('constellation_auto_light', 6 * 60 * 60 * 1000, async () => {
                if (!isGatewayReady()) return;
                try {
                    const { lightConstellation } = require('../services/activity');
                    const result = await lightConstellation();
                    if (result && result.outcome === 'lighted') {
                        log('活动', '观星自动点亮成功，当日星宿奖励已入包', { accountId: String(process.env.FARM_ACCOUNT_ID || '') });
                    } else if (result && result.error) {
                        log('活动', `观星自动点亮跳过: ${result.error}`, { accountId: String(process.env.FARM_ACCOUNT_ID || '') });
                    }
                } catch (e) {
                    const msg = errorMessage(e);
                    if (msg.includes('未发现星座活动') || msg.includes('1034038')) return;
                    log('活动', `观星自动点亮失败: ${msg}`, { accountId: String(process.env.FARM_ACCOUNT_ID || '') });
                }
            }, { preventOverlap: true });
            initialLoginInitialized = true;
        }
        
        startFarmCheckLoop({ externalScheduler: true });
        startFriendCheckLoop({ externalScheduler: true });
        automationScheduler.resume();
        // 断线时启动延迟任务可能已错过；每次重登都重置为一次短延迟幂等补跑。
        dailyRoutineScheduler.start(firstLogin ? 12000 : 1000);

        // 立即发送一次状态
        syncStatus();
    };

    connect(code, onLoginSuccess);

    // 启动定时状态同步
    workerScheduler.setIntervalTask('status_sync', 3000, syncStatus, { preventOverlap: true });
}

async function stopBot(): Promise<void> {
    if (!isRunning) return exitWorker(0);
    networkEvents.off('kickout', onKickout);
    if (onWsError) {
        networkEvents.off('ws_error', onWsError);
        onWsError = null;
    }
    if (onSellGain) {
        networkEvents.off('sell', onSellGain);
        onSellGain = null;
    }
    if (onFarmHarvested) {
        networkEvents.off('farmHarvested', onFarmHarvested);
        onFarmHarvested = null;
    }
    exitWorker(0);
}

function onKickout(payload: DynamicRecord): void {
    const reason = payload && payload.reason ? payload.reason : '未知';
    log('系统', `检测到踢下线，准备自动停止账号。原因: ${reason}`);
    sendToMaster({ type: 'account_kicked', reason });
    workerScheduler.setTimeoutTask('kickout_stop', 200, () => {
        stopBot().catch(() => exitWorker(0));
    });
}
