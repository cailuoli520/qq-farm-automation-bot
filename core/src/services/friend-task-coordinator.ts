export type FriendTaskOwner = 'patrol' | 'daily-bad' | 'rain-poetry';

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

export function resetFriendTaskCoordinator(): void {
    activeOwner = null;
}
