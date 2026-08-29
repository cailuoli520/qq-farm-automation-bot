export type FriendTaskOwner = 'patrol' | 'daily-bad' | 'rain-poetry' | 'manual-rain';

export interface FriendTaskLease {
    owner: FriendTaskOwner;
    release: () => void;
}

let activeOwner: FriendTaskOwner | null = null;

export function getActiveFriendTaskOwner(): FriendTaskOwner | null {
    return activeOwner;
}

export function tryAcquireFriendTask(owner: FriendTaskOwner): FriendTaskLease | null {
    if (activeOwner) return null;
    activeOwner = owner;
    let released = false;
    return {
        owner,
        release: () => {
            if (released) return;
            released = true;
            if (activeOwner === owner) activeOwner = null;
        },
    };
}

export async function waitForFriendTaskLease(
    owner: FriendTaskOwner,
    maxWaitMs = 10000,
    pollMs = 250,
): Promise<FriendTaskLease | null> {
    const deadline = Date.now() + Math.max(0, maxWaitMs);
    while (true) {
        const lease = tryAcquireFriendTask(owner);
        if (lease) return lease;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(Math.max(1, pollMs), remaining)));
    }
}

export function resetFriendTaskCoordinator(): void {
    activeOwner = null;
}
