export interface ApplicationFilterConfig {
    minLevel: number;
    requireOwnLevel: boolean;
    ownLevel: number;
    harvestStealEnabled: boolean;
    harvestPart: number;
    stealPart: number;
}

export interface FilterDecision {
    action: 'accept' | 'reject';
    reason?: string;
}

export function isHarvestStealFilterEnabled(config: ApplicationFilterConfig): boolean {
    return Boolean(config.harvestStealEnabled) && Number(config.harvestPart) > 0;
}

export function effectiveMinLevel(config: ApplicationFilterConfig): number {
    const manual = Math.max(0, Number(config.minLevel) || 0);
    const own = config.requireOwnLevel ? Math.max(0, Number(config.ownLevel) || 0) : 0;
    return Math.max(manual, own);
}

export function evaluateLevelFilter(applicantLevel: number, config: ApplicationFilterConfig): FilterDecision {
    const minLevel = effectiveMinLevel(config);
    const level = Math.max(0, Number(applicantLevel) || 0);
    if (minLevel <= 0 || level >= minLevel) return { action: 'accept' };
    return { action: 'reject', reason: `等级 ${level} < ${minLevel}` };
}

export function evaluateHarvestStealFilter(
    harvestCount: number,
    stealCount: number,
    config: ApplicationFilterConfig,
): FilterDecision {
    if (!isHarvestStealFilterEnabled(config)) return { action: 'accept' };
    const harvest = Math.max(0, Number(harvestCount) || 0);
    const steal = Math.max(0, Number(stealCount) || 0);
    const harvestPart = Math.max(1, Number(config.harvestPart) || 1);
    const stealPart = Math.max(1, Number(config.stealPart) || 1);
    if (steal === 0 || harvest * stealPart >= steal * harvestPart) return { action: 'accept' };
    return { action: 'reject', reason: `收偷比 ${harvest}:${steal} 低于 ${harvestPart}:${stealPart}` };
}
