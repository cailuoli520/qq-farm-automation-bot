import type { CoalescedBackgroundTask } from '../utils/request-coordination';
import { createCoalescedBackgroundTask } from '../utils/request-coordination';

type PetGiftListener = (count: unknown) => void;

interface PetGiftEventBus {
    on: (event: 'dogSkillGiftPending', listener: PetGiftListener) => unknown;
    off: (event: 'dogSkillGiftPending', listener: PetGiftListener) => unknown;
}

interface PetGiftService {
    claimDogSkillGifts: (pendingCountHint?: unknown) => PromiseLike<{ claimed?: number }>;
}

interface WorkerPetGiftOptions {
    events: PetGiftEventBus;
    service: PetGiftService;
    isLifecycleActive: () => boolean;
    log: (tag: string, message: string, meta?: Record<string, unknown>) => void;
    delayMs?: number;
}

export interface WorkerPetGiftRuntime {
    checkNow: () => void;
    start: () => void;
    stop: () => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown');
}

export function createWorkerPetGiftRuntime(options: WorkerPetGiftOptions): WorkerPetGiftRuntime {
    const { events, service, isLifecycleActive, log, delayMs = 300 } = options;
    let listener: PetGiftListener | null = null;
    let task: CoalescedBackgroundTask | null = null;
    let pendingHint = 0;

    function ensureTask(): CoalescedBackgroundTask {
        if (task) return task;
        task = createCoalescedBackgroundTask(async () => {
            if (!isLifecycleActive()) return;
            const hint = pendingHint;
            pendingHint = 0;
            await service.claimDogSkillGifts(hint || undefined);
        }, {
            delayMs,
            onError: (error: unknown) => {
                if (!isLifecycleActive()) return;
                const reason = errorMessage(error);
                log('宠物', `自动领取同气连枝礼包失败: ${reason}`, {
                    module: 'dog', event: '同气连枝礼包自动领取', result: 'error', error: reason,
                });
            },
        });
        return task;
    }

    function checkNow(): void {
        if (!isLifecycleActive()) return;
        ensureTask().trigger();
    }

    function start(): void {
        if (listener) events.off('dogSkillGiftPending', listener);
        const claimTask = ensureTask();
        listener = (count: unknown) => {
            const numeric = Math.max(0, Number(count) || 0);
            if (!isLifecycleActive() || numeric <= 0) return;
            pendingHint = Math.max(pendingHint, numeric);
            claimTask.trigger();
        };
        events.on('dogSkillGiftPending', listener);
    }

    function stop(): void {
        if (listener) {
            events.off('dogSkillGiftPending', listener);
            listener = null;
        }
        task?.cancel();
        task = null;
        pendingHint = 0;
    }

    return { checkNow, start, stop };
}
