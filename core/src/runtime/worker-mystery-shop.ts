import type EventEmitter from 'node:events';
import type { MysteryShopOffer } from '../services/mystery-shop';

type DynamicRecord = Record<string, any>;
type MysteryShopOutcome = 'purchased' | 'disabled' | 'inactive' | 'expired' | 'duplicate' | 'stopped' | 'failed'
    | 'currency_not_allowed' | 'balance_unknown' | 'insufficient';

const CURRENCY_CONFIG_KEYS: Record<string, string> = {
    '1': 'mystery_shop_allow_gold',
    '1001': 'mystery_shop_allow_gold',
    '1002': 'mystery_shop_allow_coupon',
    '1004': 'mystery_shop_allow_diamond',
    '1005': 'mystery_shop_allow_gold_bean',
};

const POLL_INTERVAL_MS = 10 * 60 * 1000;

interface MysteryShopService {
    buyNpcGoods: (npcId: unknown) => unknown | PromiseLike<unknown>;
    getActiveNPC: () => unknown | PromiseLike<unknown>;
    mysteryRewards: (value: unknown) => Array<{ id: string; count: string; name: string }>;
    normalizeMysteryShopOffer: (value: unknown) => MysteryShopOffer | null;
}

interface WorkerMysteryShopRuntimeOptions {
    events: EventEmitter;
    getAutomation: () => DynamicRecord;
    isLifecycleActive: () => boolean;
    log: (tag: string, message: string, meta?: DynamicRecord) => void;
    getCurrencyBalance?: (currencyId: string) => unknown;
    notify?: (title: string, content: string) => unknown | PromiseLike<unknown>;
    now?: () => number;
    service: MysteryShopService;
}

export interface WorkerMysteryShopRuntime {
    checkNow: () => Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }>;
    handleOffer: (value: unknown, source?: string) => Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }>;
    start: () => void;
    stop: () => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

export function createWorkerMysteryShopRuntime(
    options: WorkerMysteryShopRuntimeOptions,
): WorkerMysteryShopRuntime {
    const {
        events,
        getAutomation,
        isLifecycleActive,
        log,
        getCurrencyBalance = () => null,
        notify,
        now = Date.now,
        service,
    } = options;
    let started = false;
    let lastPurchasedKey = '';
    let lastArrivalNotifyKey = '';
    let lastPurchaseNotifyKey = '';
    let pollTimer: NodeJS.Timeout | null = null;
    let pending: null | {
        key: string;
        promise: Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }>;
    } = null;

    async function handleOffer(
        value: unknown,
        source = 'push',
    ): Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }> {
        if (!isLifecycleActive()) return { outcome: 'stopped' };
        const automation = getAutomation() || {};
        const autoBuy = automation.mystery_shop_buy === true;
        const arrivalNotify = automation.mystery_shop_arrival_notify === true;
        if (!autoBuy && !arrivalNotify) return { outcome: 'disabled' };
        const offer = service.normalizeMysteryShopOffer(value);
        if (!offer) return { outcome: 'inactive' };
        if (offer.expireTime > 0 && offer.expireTime * 1000 <= now()) return { outcome: 'expired', offer };
        const shouldNotifyArrival = arrivalNotify && lastArrivalNotifyKey !== offer.key;
        const sendNotificationSafely = async (title: string, content: string): Promise<boolean> => {
            if (!notify) return false;
            try {
                await notify(title, content);
                return true;
            } catch (error) {
                log('神秘商人', `消息提醒发送失败: ${errorMessage(error)}`, {
                    module: 'mystery-shop', event: 'notify', result: 'error',
                });
                return false;
            }
        };
        const notifyArrivalOnce = async (): Promise<void> => {
            if (!shouldNotifyArrival) return;
            const sent = await sendNotificationSafely(
                '神秘商人到货',
                `${offer.reward.name || `物品#${offer.reward.id}`} x${offer.reward.count}\n价格 ${offer.currency.totalPrice} ${offer.currency.name}`,
            );
            if (sent) lastArrivalNotifyKey = offer.key;
        };
        if (!autoBuy) {
            await notifyArrivalOnce();
            return { outcome: 'disabled', offer };
        }
        if (lastPurchasedKey === offer.key) return { outcome: 'duplicate', offer };
        if (pending?.key === offer.key) return pending.promise;

        const currencyConfigKey = CURRENCY_CONFIG_KEYS[offer.currency.id];
        if (!currencyConfigKey || automation[currencyConfigKey] !== true) {
            log('神秘商人', `自动购买已跳过: 未允许使用${offer.currency.name}`, {
                module: 'mystery-shop', event: 'auto_buy', result: 'skip', reason: 'currency_not_allowed',
                currencyId: offer.currency.id,
            });
            await notifyArrivalOnce();
            return { outcome: 'currency_not_allowed', offer };
        }
        const balanceText = String(getCurrencyBalance(offer.currency.id) ?? '').trim();
        if (!/^\d+$/.test(balanceText)) {
            log('神秘商人', `自动购买已跳过: 未能读取${offer.currency.name}余额`, {
                module: 'mystery-shop', event: 'auto_buy', result: 'skip', reason: 'balance_unknown',
                currencyId: offer.currency.id,
            });
            await notifyArrivalOnce();
            return { outcome: 'balance_unknown', offer };
        }
        if (BigInt(balanceText) < BigInt(offer.currency.totalPrice)) {
            log('神秘商人', `自动购买已跳过: ${offer.currency.name}余额不足`, {
                module: 'mystery-shop', event: 'auto_buy', result: 'skip', reason: 'insufficient',
                currencyId: offer.currency.id, balance: balanceText, totalPrice: offer.currency.totalPrice,
            });
            await notifyArrivalOnce();
            return { outcome: 'insufficient', offer };
        }

        const promise = (async (): Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }> => {
            try {
                const reply = await service.buyNpcGoods(offer.npcId);
                if (!isLifecycleActive()) return { outcome: 'stopped', offer };
                lastPurchasedKey = offer.key;
                const rewards = service.mysteryRewards(reply);
                const rewardSummary = rewards.length > 0
                    ? rewards.map(item => `${item.name || `物品#${item.id}`}x${item.count}`).join('、')
                    : `${offer.reward.name || `物品#${offer.reward.id}`}x${offer.reward.count}`;
                log('神秘商人', `自动购买成功: ${rewardSummary}，花费${offer.currency.name}${offer.currency.totalPrice}`, {
                    module: 'mystery-shop',
                    event: 'auto_buy',
                    result: 'ok',
                    source,
                    npcId: offer.npcId,
                    rewardItemId: offer.reward.id,
                    rewardCount: offer.reward.count,
                    currencyId: offer.currency.id,
                    totalPrice: offer.currency.totalPrice,
                });
                const shouldNotifyPurchase = automation.mystery_shop_purchase_notify === true
                    && lastPurchaseNotifyKey !== offer.key;
                if (shouldNotifyArrival || shouldNotifyPurchase) {
                    const sent = await sendNotificationSafely(
                        '神秘商人已自动购买',
                        `${rewardSummary}\n花费 ${offer.currency.totalPrice} ${offer.currency.name}`,
                    );
                    if (sent) {
                        if (shouldNotifyArrival) lastArrivalNotifyKey = offer.key;
                        if (shouldNotifyPurchase) lastPurchaseNotifyKey = offer.key;
                    }
                }
                return { outcome: 'purchased', offer };
            } catch (error) {
                const reason = errorMessage(error);
                if (isLifecycleActive()) {
                    log('神秘商人', `自动购买失败: ${reason}`, {
                        module: 'mystery-shop',
                        event: 'auto_buy',
                        result: 'error',
                        source,
                        npcId: offer.npcId,
                        error: reason,
                    });
                }
                await notifyArrivalOnce();
                return { outcome: 'failed', offer };
            }
        })();
        pending = { key: offer.key, promise };
        try {
            return await promise;
        } finally {
            if (pending?.promise === promise) pending = null;
        }
    }

    async function checkNow(): Promise<{ outcome: MysteryShopOutcome; offer?: MysteryShopOffer }> {
        if (!isLifecycleActive()) return { outcome: 'stopped' };
        const automation = getAutomation() || {};
        if (automation.mystery_shop_buy !== true && automation.mystery_shop_arrival_notify !== true) {
            return { outcome: 'disabled' };
        }
        try {
            return await handleOffer(await service.getActiveNPC(), 'active-query');
        } catch (error) {
            const reason = errorMessage(error);
            if (isLifecycleActive()) {
                log('神秘商人', `查询当前商人失败: ${reason}`, {
                    module: 'mystery-shop',
                    event: 'active_query',
                    result: 'error',
                    error: reason,
                });
            }
            return { outcome: 'failed' };
        }
    }

    const onNotify = (value: unknown): void => {
        void handleOffer(value, 'push');
    };

    function start(): void {
        if (started) return;
        started = true;
        events.on('mysteryShopNotify', onNotify);
        pollTimer = setInterval(() => { void checkNow(); }, POLL_INTERVAL_MS);
        pollTimer.unref?.();
    }

    function stop(): void {
        if (!started) return;
        started = false;
        events.off('mysteryShopNotify', onNotify);
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        pending = null;
    }

    return { checkNow, handleOffer, start, stop };
}
