import type { Scheduler } from '../services/scheduler';
import type { FriendTaskLease } from '../services/friend-task-coordinator';
import type { FriendVisitContext, FriendVisitObserver } from '../services/friend-visit';
import { getFriendsList, inFriendQuietHours } from '../services/friend-directory';
import { tryAcquireFriendTask } from '../services/friend-task-coordinator';
import { registerFriendVisitObserver, withFriendVisit } from '../services/friend-visit';
import { normalizeWeather } from '../services/rain-poetry';
import { randomDelay } from '../utils/utils';
import { planRainPoetryAutomation } from './rain-poetry-policy';

const { getFriendBlacklist } = require('../models/store');

type DynamicRecord = Record<string, any>;
type RainRunOutcome = 'completed' | 'busy' | 'disabled' | 'inactive' | 'failed' | 'stopped';

const POLL_INTERVAL_MS = 30 * 60 * 1000;
const BUSY_RETRY_MS = 5 * 60 * 1000;
const FRIEND_RECENT_TTL_MS = 30 * 60 * 1000;

interface RainPoetryAutomationService {
    collectRainWeatherFromVisit: (friendGid: unknown, enterReply: unknown, activity?: unknown) => Promise<DynamicRecord>;
    exchangeRainBottle: (goodsId: unknown, count: unknown) => Promise<DynamicRecord>;
    getCurrentRainPoetryActivity: () => Promise<DynamicRecord | null>;
    unlockRainResearch: (nodeId: unknown) => Promise<DynamicRecord>;
    useRainThunderstorm: () => Promise<DynamicRecord>;
}

interface RainPoetryFriendPort {
    getBlacklist: () => number[];
    inQuietHours: () => boolean;
    list: () => Promise<DynamicRecord[]>;
    normalizeWeather: (value: unknown) => DynamicRecord;
    randomDelay: (minMs: number, maxMs: number) => Promise<unknown>;
    registerObserver: (observer: FriendVisitObserver) => () => void;
    tryAcquireTask: () => FriendTaskLease | null;
    visit: (friend: DynamicRecord) => Promise<void>;
}

interface WorkerRainPoetryRuntimeOptions {
    friend?: Partial<RainPoetryFriendPort>;
    getAutomation: () => DynamicRecord;
    isLifecycleActive: () => boolean;
    log: (tag: string, message: string, meta?: DynamicRecord) => void;
    now?: () => number;
    scheduler: Scheduler;
    service: RainPoetryAutomationService;
}

export interface WorkerRainPoetryRuntime {
    checkNow: (source?: string) => Promise<RainRunOutcome>;
    start: () => void;
    stop: () => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

function snapshotFromMutation(result: DynamicRecord): DynamicRecord | null {
    const snapshot = result?.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || !Object.prototype.hasOwnProperty.call(snapshot, 'rainPoetry')) return null;
    return snapshot.rainPoetry && typeof snapshot.rainPoetry === 'object' ? snapshot.rainPoetry : {};
}

export function createWorkerRainPoetryRuntime(options: WorkerRainPoetryRuntimeOptions): WorkerRainPoetryRuntime {
    const { getAutomation, isLifecycleActive, log, scheduler, service } = options;
    const now = options.now || Date.now;
    const friend: RainPoetryFriendPort = {
        getBlacklist: () => getFriendBlacklist(),
        inQuietHours: inFriendQuietHours,
        list: () => getFriendsList(),
        normalizeWeather,
        randomDelay,
        registerObserver: registerFriendVisitObserver,
        tryAcquireTask: () => tryAcquireFriendTask('rain-poetry'),
        visit: async (entry) => {
            await withFriendVisit({
                source: 'rain-fallback',
                friendGid: entry.gid,
                friendName: entry.name,
            }, async () => undefined);
        },
        ...options.friend,
    };
    let started = false;
    let unregisterObserver: (() => void) | null = null;
    let pending: Promise<RainRunOutcome> | null = null;
    let lastSnapshot: DynamicRecord | null = null;
    let scanCursor = 0;
    let inactiveLogged = false;
    let friendSnapshotDirty = false;
    const recentlyCheckedAt = new Map<string, number>();

    function enabled(): boolean {
        return getAutomation()?.rain_poetry_auto === true;
    }

    function interruptionOutcome(): 'disabled' | 'stopped' | null {
        if (!enabled()) return 'disabled';
        if (!started || !isLifecycleActive()) return 'stopped';
        return null;
    }

    function setSnapshot(value: DynamicRecord | null): void {
        lastSnapshot = value && typeof value === 'object' ? value : null;
    }

    function updateSnapshotFromMutation(result: DynamicRecord): void {
        setSnapshot(snapshotFromMutation(result));
    }

    function cleanupRecentFriends(): void {
        const oldest = now() - FRIEND_RECENT_TTL_MS;
        for (const [gid, checkedAt] of recentlyCheckedAt.entries()) {
            if (checkedAt < oldest) recentlyCheckedAt.delete(gid);
        }
    }

    function stopScheduling(): void {
        scheduler.clear('rain_poetry_poll');
        scheduler.clear('rain_poetry_busy_retry');
        scheduler.clear('rain_poetry_after_collect');
    }

    function ensureObserver(): void {
        if (!unregisterObserver) unregisterObserver = friend.registerObserver(handleFriendVisit);
    }

    function deactivateForInactiveActivity(): void {
        // 暂停活动操作，但保留低频发现轮询。活动可能尚未开始，活动列表查询也可能
        // 暂时失败；只有 Worker 停止或配置关闭时才彻底清理轮询。
        scheduler.clear('rain_poetry_busy_retry');
        scheduler.clear('rain_poetry_after_collect');
        unregisterObserver?.();
        unregisterObserver = null;
        if (!inactiveLogged) {
            inactiveLogged = true;
            log('活动', '雨落成诗活动未开放或已经结束，自动操作已暂停，将继续定时检测', {
                module: 'rain-poetry', event: 'auto_pause', result: 'inactive',
            });
        }
    }

    async function refreshAfterMutation(result: DynamicRecord): Promise<DynamicRecord> {
        updateSnapshotFromMutation(result);
        if (lastSnapshot === null) setSnapshot(await service.getCurrentRainPoetryActivity());
        return lastSnapshot || {};
    }

    async function unlockAvailableResearch(): Promise<void> {
        let attempts = 0;
        while (lastSnapshot?.active && attempts < 64) {
            if (interruptionOutcome()) return;
            const nodeId = planRainPoetryAutomation(lastSnapshot).researchNodeIds[0];
            if (!nodeId) return;
            attempts += 1;
            try {
                const result = await service.unlockRainResearch(nodeId);
                await refreshAfterMutation(result);
                if (interruptionOutcome()) return;
                log('活动', `雨落成诗自动解锁气象研究节点 ${nodeId}`, {
                    module: 'rain-poetry', event: 'auto_research', result: 'ok', nodeId,
                });
            } catch (error) {
                log('活动', `雨落成诗自动解锁研究失败: ${errorMessage(error)}`, {
                    module: 'rain-poetry', event: 'auto_research', result: 'error', nodeId,
                });
                return;
            }
        }
    }

    async function handleFriendVisit(context: FriendVisitContext): Promise<void> {
        if (!started || !enabled() || !isLifecycleActive()) return;
        if (!context.enterReply?.weather_status) return;
        const gid = String(context.friendGid || '');
        if (!gid) return;
        const weather = friend.normalizeWeather(context.enterReply.weather_status);
        const plan = planRainPoetryAutomation(lastSnapshot);
        if (!weather.thunderstorm) {
            recentlyCheckedAt.set(gid, now());
            return;
        }
        if (!plan.active || plan.collectionBottleCount <= 0n) {
            if (plan.active && !plan.exchangeGoodsId) recentlyCheckedAt.set(gid, now());
            return;
        }
        try {
            const result = await service.collectRainWeatherFromVisit(gid, context.enterReply, lastSnapshot);
            if (result?.rainPoetry && typeof result.rainPoetry === 'object') {
                setSnapshot(result.rainPoetry);
            } else if (lastSnapshot) {
                const currentCount = plan.collectionBottleCount;
                setSnapshot({
                    ...lastSnapshot,
                    balances: {
                        ...lastSnapshot.balances,
                        collectionBottle: (currentCount > 0n ? currentCount - 1n : 0n).toString(),
                    },
                });
            }
            friendSnapshotDirty = true;
            recentlyCheckedAt.set(gid, now());
            if (context.source !== 'rain-fallback') {
                scheduler.setTimeoutTask('rain_poetry_after_collect', 1000, () => checkNow('friend-collect'));
            }
            log('活动', `雨落成诗已从 ${context.friendName} 采集雷雨天气`, {
                module: 'rain-poetry', event: 'auto_collect', result: 'ok',
                friendGid: gid, friendName: context.friendName, source: context.source,
            });
        } catch (error) {
            recentlyCheckedAt.delete(gid);
            log('活动', `雨落成诗采集 ${context.friendName} 天气失败: ${errorMessage(error)}`, {
                module: 'rain-poetry', event: 'auto_collect', result: 'error',
                friendGid: gid, friendName: context.friendName, source: context.source,
            });
        }
    }

    function scheduleBusyRetry(): void {
        if (!started || !enabled()) return;
        scheduler.setTimeoutTask('rain_poetry_busy_retry', BUSY_RETRY_MS, () => checkNow('busy-retry'));
    }

    async function scanFriends(): Promise<'completed' | 'busy'> {
        if (friend.inQuietHours()) return 'completed';
        const lease = friend.tryAcquireTask();
        if (!lease) {
            scheduleBusyRetry();
            return 'busy';
        }
        try {
            cleanupRecentFriends();
            const blacklist = new Set(friend.getBlacklist().map(Number));
            const seen = new Set<number>();
            const entries = (await friend.list()).filter((entry) => {
                const gid = Number(entry?.gid || 0);
                if (gid <= 0 || seen.has(gid) || blacklist.has(gid) || recentlyCheckedAt.has(String(gid))) return false;
                seen.add(gid);
                return true;
            });
            if (entries.length === 0) return 'completed';
            const start = scanCursor % entries.length;
            const ordered = entries.slice(start).concat(entries.slice(0, start));
            let visited = 0;
            for (const entry of ordered) {
                if (!planRainPoetryAutomation(lastSnapshot).shouldScanFriends) break;
                if (!started || !enabled() || !isLifecycleActive()) break;
                try {
                    await friend.visit(entry);
                } catch (error) {
                    log('活动', `雨落成诗检查好友 ${entry.name || entry.gid} 失败: ${errorMessage(error)}`, {
                        module: 'rain-poetry', event: 'friend_scan', result: 'error', friendGid: String(entry.gid || ''),
                    });
                }
                visited += 1;
                await friend.randomDelay(1500, 2500);
            }
            scanCursor = (start + Math.max(1, visited)) % entries.length;
            return 'completed';
        } finally {
            lease.release();
        }
    }

    async function runCycle(source: string): Promise<RainRunOutcome> {
        const interrupted = interruptionOutcome();
        if (interrupted) return interrupted;
        try {
            setSnapshot(await service.getCurrentRainPoetryActivity());
            friendSnapshotDirty = false;
            scheduler.clear('rain_poetry_after_collect');
            const afterRead = interruptionOutcome();
            if (afterRead) return afterRead;
            if (!lastSnapshot?.active) {
                deactivateForInactiveActivity();
                return 'inactive';
            }
            ensureObserver();
            inactiveLogged = false;
            let plan = planRainPoetryAutomation(lastSnapshot);
            if (plan.exchangeGoodsId) {
                try {
                    const result = await service.exchangeRainBottle(plan.exchangeGoodsId, 1);
                    await refreshAfterMutation(result);
                    log('活动', '雨落成诗已自动兑换天气采集瓶', {
                        module: 'rain-poetry', event: 'auto_exchange', result: 'ok', source,
                    });
                } catch (error) {
                    log('活动', `雨落成诗自动兑换失败: ${errorMessage(error)}`, {
                        module: 'rain-poetry', event: 'auto_exchange', result: 'error', source,
                    });
                }
            }
            const afterExchange = interruptionOutcome();
            if (afterExchange) return afterExchange;
            await unlockAvailableResearch();
            const afterResearch = interruptionOutcome();
            if (afterResearch) return afterResearch;
            plan = planRainPoetryAutomation(lastSnapshot);
            if (plan.useThunderstorm) {
                try {
                    const result = await service.useRainThunderstorm();
                    await refreshAfterMutation(result);
                    log('活动', '雨落成诗已自动使用雷雨召唤瓶', {
                        module: 'rain-poetry', event: 'auto_thunderstorm', result: 'ok', source,
                    });
                } catch (error) {
                    log('活动', `雨落成诗自动召唤雷雨失败: ${errorMessage(error)}`, {
                        module: 'rain-poetry', event: 'auto_thunderstorm', result: 'error', source,
                    });
                }
            }
            const afterThunderstorm = interruptionOutcome();
            if (afterThunderstorm) return afterThunderstorm;
            if (planRainPoetryAutomation(lastSnapshot).shouldScanFriends) {
                const scanOutcome = await scanFriends();
                if (scanOutcome === 'busy') return 'busy';
            }
            if (friendSnapshotDirty) {
                scheduler.clear('rain_poetry_after_collect');
                friendSnapshotDirty = false;
                setSnapshot(await service.getCurrentRainPoetryActivity());
                if (!lastSnapshot?.active) {
                    deactivateForInactiveActivity();
                    return 'inactive';
                }
            }
            await unlockAvailableResearch();
            return 'completed';
        } catch (error) {
            log('活动', `雨落成诗自动任务失败: ${errorMessage(error)}`, {
                module: 'rain-poetry', event: 'auto_cycle', result: 'error', source,
            });
            return 'failed';
        }
    }

    function checkNow(source = 'manual'): Promise<RainRunOutcome> {
        if (pending) return pending;
        const request = runCycle(source);
        pending = request;
        request.finally(() => {
            if (pending === request) pending = null;
        }).catch(() => undefined);
        return request;
    }

    function start(): void {
        if (started || !enabled() || !isLifecycleActive()) return;
        started = true;
        inactiveLogged = false;
        ensureObserver();
        scheduler.setIntervalTask('rain_poetry_poll', POLL_INTERVAL_MS, () => checkNow('poll'), { preventOverlap: true });
    }

    function stop(): void {
        started = false;
        stopScheduling();
        unregisterObserver?.();
        unregisterObserver = null;
        lastSnapshot = null;
        friendSnapshotDirty = false;
        recentlyCheckedAt.clear();
    }

    return { checkNow, start, stop };
}
