import { sendMsgAsync } from '../utils/network';
import { types } from '../utils/proto';
import { toLong } from '../utils/utils';

type DynamicRecord = Record<string, any>;

export type FriendVisitSource = 'patrol' | 'steal' | 'help' | 'bad' | 'rain-fallback' | 'manual';

export interface FriendVisitContext {
    source: FriendVisitSource;
    friendGid: string;
    friendName: string;
    enterReply: DynamicRecord;
}

export type FriendVisitObserver = (context: FriendVisitContext) => void | Promise<void>;

interface FriendVisitOptions {
    source: FriendVisitSource;
    friendGid: unknown;
    friendName?: unknown;
    enter?: (friendGid: any) => Promise<DynamicRecord>;
    leave?: (friendGid: any) => Promise<unknown>;
    onLeaveError?: (error: unknown, context: FriendVisitContext) => void;
    onObserverError?: (error: unknown, context: FriendVisitContext) => void;
}

const AUTOMATED_SOURCES = new Set<FriendVisitSource>(['patrol', 'steal', 'help', 'bad', 'rain-fallback']);
const visitObservers = new Set<FriendVisitObserver>();

export class FriendVisitEnterError extends Error {
    readonly cause: unknown;

    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'FriendVisitEnterError';
        this.cause = cause;
    }
}

export async function enterFriendFarm(friendGid: unknown): Promise<DynamicRecord> {
    const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(friendGid),
        reason: 2,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body);
    return types.VisitEnterReply.decode(replyBody);
}

export async function leaveFriendFarm(friendGid: unknown): Promise<void> {
    const body = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({
        host_gid: toLong(friendGid),
    })).finish();
    await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body);
}

export function registerFriendVisitObserver(observer: FriendVisitObserver): () => void {
    visitObservers.add(observer);
    return () => visitObservers.delete(observer);
}

async function notifyObservers(context: FriendVisitContext, onError?: FriendVisitOptions['onObserverError']): Promise<void> {
    if (!AUTOMATED_SOURCES.has(context.source)) return;
    for (const observer of visitObservers) {
        try {
            await observer(context);
        } catch (error) {
            onError?.(error, context);
        }
    }
}

export async function withFriendVisit<T>(
    options: FriendVisitOptions,
    handler: (context: FriendVisitContext) => Promise<T>,
): Promise<T> {
    const enter = options.enter || enterFriendFarm;
    const leave = options.leave || leaveFriendFarm;
    let enterReply: DynamicRecord;
    try {
        enterReply = await enter(options.friendGid);
    } catch (error) {
        throw new FriendVisitEnterError(error);
    }
    const context: FriendVisitContext = {
        source: options.source,
        friendGid: String(options.friendGid ?? ''),
        friendName: String(options.friendName || `GID:${options.friendGid ?? ''}`),
        enterReply,
    };
    try {
        await notifyObservers(context, options.onObserverError);
        return await handler(context);
    } finally {
        try {
            await leave(options.friendGid);
        } catch (error) {
            options.onLeaveError?.(error, context);
        }
    }
}
