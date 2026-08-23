export interface DailyExecutionGate {
    tryStart: (busy: boolean, scheduleRetry: () => void) => boolean;
}

export function createDailyExecutionGate(getDateKey: () => string): DailyExecutionGate {
    let lastExecutionDate = '';

    return {
        tryStart(busy: boolean, scheduleRetry: () => void): boolean {
            const today = getDateKey();
            if (lastExecutionDate === today) return false;
            if (busy) {
                scheduleRetry();
                return false;
            }
            lastExecutionDate = today;
            return true;
        },
    };
}
