import type { Scheduler } from '../services/scheduler';

interface WorkerDailyRoutineSchedulerOptions {
    getDateKey: () => string;
    isLoginReady: () => boolean;
    pollIntervalMs?: number;
    runCrossDayRoutines: () => unknown | PromiseLike<unknown>;
    runStartupRoutines: () => unknown | PromiseLike<unknown>;
    scheduler: Scheduler;
}

export interface WorkerDailyRoutineScheduler {
    start: (initialDelayMs?: number) => void;
    stop: () => void;
}

export function createWorkerDailyRoutineScheduler(
    options: WorkerDailyRoutineSchedulerOptions,
): WorkerDailyRoutineScheduler {
    const pollIntervalMs = Math.max(1000, Number(options.pollIntervalMs) || 30 * 1000);
    let lastRunDate = '';

    function stop(): void {
        options.scheduler.clear('daily_routine_interval');
        options.scheduler.clear('daily_routine_startup');
    }

    function start(initialDelayMs = 12000): void {
        stop();
        lastRunDate = options.getDateKey();
        options.scheduler.setTimeoutTask('daily_routine_startup', initialDelayMs, async () => {
            // 启动延迟可能跨过北京时间零点；以实际执行日作为已处理日期，避免紧接着重复跑跨日日常。
            lastRunDate = options.getDateKey();
            await options.runStartupRoutines();
        });
        options.scheduler.setIntervalTask('daily_routine_interval', pollIntervalMs, async () => {
            if (!options.isLoginReady()) return;
            const today = options.getDateKey();
            if (today === lastRunDate) return;
            lastRunDate = today;
            await options.runCrossDayRoutines();
        }, { preventOverlap: true });
    }

    return { start, stop };
}
