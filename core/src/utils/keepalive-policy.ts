export const HEARTBEAT_STALE_AFTER_MS = 30_000;
export const MAX_HEARTBEAT_MISSES = 3;

export function shouldReconnectForHeartbeat(missCount: number, inboundSilenceMs: number): boolean {
    return Number(missCount) >= MAX_HEARTBEAT_MISSES
        && Number(inboundSilenceMs) > HEARTBEAT_STALE_AFTER_MS;
}
