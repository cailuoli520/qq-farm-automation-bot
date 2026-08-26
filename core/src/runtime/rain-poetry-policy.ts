type DynamicRecord = Record<string, any>;

const THUNDERSTORM_BOTTLE_ITEM_ID = '5002';

export interface RainPoetryAutomationPlan {
    active: boolean;
    collectionBottleCount: bigint;
    exchangeGoodsId: string | null;
    researchNodeIds: string[];
    shouldScanFriends: boolean;
    useThunderstorm: boolean;
}

function amount(value: unknown): bigint {
    const text = String(value ?? '0');
    return /^\d+$/.test(text) ? BigInt(text) : 0n;
}

function taskNeedsThunderstorm(task: DynamicRecord): boolean {
    if (task?.completed === true) return false;
    const target = amount(task?.target);
    if (target <= 0n || amount(task?.progress) >= target) return false;
    const itemId = String(task?.itemId ?? task?.item_id ?? '');
    const name = String(task?.name || '');
    return itemId === THUNDERSTORM_BOTTLE_ITEM_ID || name.includes('闪电变异');
}

export function planRainPoetryAutomation(snapshotInput: unknown): RainPoetryAutomationPlan {
    const snapshot = snapshotInput && typeof snapshotInput === 'object'
        ? snapshotInput as DynamicRecord
        : {};
    const active = snapshot.active === true;
    const collectionBottleCount = active ? amount(snapshot.balances?.collectionBottle) : 0n;
    const exchangeItem = active && Array.isArray(snapshot.exchangeItems)
        ? snapshot.exchangeItems.find((entry: DynamicRecord) => (
            entry?.available === true && String(entry?.item?.id || '') === '5001'
        ))
        : null;
    const researchNodeIds = active && Array.isArray(snapshot.researchNodes)
        ? snapshot.researchNodes
            .filter((entry: DynamicRecord) => entry?.unlockable === true && entry?.claimed !== true)
            .map((entry: DynamicRecord) => String(entry.id || ''))
            .filter(Boolean)
        : [];
    const needsThunderstorm = active && Array.isArray(snapshot.tasks)
        && snapshot.tasks.some((task: DynamicRecord) => taskNeedsThunderstorm(task));
    return {
        active,
        collectionBottleCount,
        exchangeGoodsId: exchangeItem ? String(exchangeItem.id || '') || null : null,
        researchNodeIds,
        shouldScanFriends: active && collectionBottleCount > 0n,
        useThunderstorm: needsThunderstorm && snapshot.actions?.thunderstorm?.enabled === true,
    };
}
