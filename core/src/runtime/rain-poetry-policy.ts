type DynamicRecord = Record<string, any>;

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
    return {
        active,
        collectionBottleCount,
        exchangeGoodsId: exchangeItem ? String(exchangeItem.id || '') || null : null,
        researchNodeIds,
        shouldScanFriends: active && collectionBottleCount > 0n,
        useThunderstorm: active && snapshot.actions?.thunderstorm?.enabled === true,
    };
}
