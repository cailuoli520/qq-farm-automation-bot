const assert = require('node:assert/strict');
const test = require('node:test');
const {
    FriendVisitEnterError,
    registerFriendVisitObserver,
    withFriendVisit,
} = require('../src/services/friend-visit');
const {
    resetFriendTaskCoordinator,
    tryAcquireFriendTask,
} = require('../src/services/friend-task-coordinator');

test('好友访问会话在处理失败时仍离开农场', async () => {
    const calls: string[] = [];
    await assert.rejects(
        withFriendVisit({
            source: 'patrol',
            friendGid: '123',
            enter: async () => {
                calls.push('enter');
                return { lands: [] };
            },
            leave: async () => { calls.push('leave'); },
        }, async () => {
            calls.push('handle');
            throw new Error('boom');
        }),
        /boom/,
    );
    assert.deepEqual(calls, ['enter', 'handle', 'leave']);
});

test('自动好友访问通知观察器，手动访问不通知且观察器异常被隔离', async () => {
    const observed: string[] = [];
    const observerErrors: string[] = [];
    const unregister = registerFriendVisitObserver(async (context) => {
        observed.push(context.source);
        throw new Error('observer boom');
    });
    const options = {
        friendGid: '123',
        enter: async () => ({ weather_status: { active: false } }),
        leave: async () => undefined,
        onObserverError: error => observerErrors.push(error.message),
    };
    try {
        assert.equal(await withFriendVisit({ ...options, source: 'patrol' }, async () => 'ok'), 'ok');
        assert.equal(await withFriendVisit({ ...options, source: 'manual' }, async () => 'manual'), 'manual');
    } finally {
        unregister();
    }
    assert.deepEqual(observed, ['patrol']);
    assert.deepEqual(observerErrors, ['observer boom']);
});

test('进入好友失败时不执行处理和离开，并保留原始错误', async () => {
    let handled = false;
    let left = false;
    await assert.rejects(
        withFriendVisit({
            source: 'patrol',
            friendGid: '123',
            enter: async () => { throw new Error('enter failed'); },
            leave: async () => { left = true; },
        }, async () => { handled = true; }),
        error => error instanceof FriendVisitEnterError && error.cause?.message === 'enter failed',
    );
    assert.equal(handled, false);
    assert.equal(left, false);
});

test('空土地仍执行观察和处理，并在离开失败时保留原操作结果', async () => {
    const calls: string[] = [];
    const leaveErrors: string[] = [];
    const unregister = registerFriendVisitObserver(() => { calls.push('observe'); });
    try {
        const result = await withFriendVisit({
            source: 'patrol',
            friendGid: '123',
            enter: async () => {
                calls.push('enter');
                return { lands: [] };
            },
            leave: async () => {
                calls.push('leave');
                throw new Error('leave failed');
            },
            onLeaveError: error => leaveErrors.push(error instanceof Error ? error.message : String(error)),
        }, async ({ enterReply }) => {
            calls.push('handle');
            assert.deepEqual(enterReply.lands, []);
            return 'ok';
        });
        assert.equal(result, 'ok');
    } finally {
        unregister();
    }
    assert.deepEqual(calls, ['enter', 'observe', 'handle', 'leave']);
    assert.deepEqual(leaveErrors, ['leave failed']);
});

test('好友任务协调器互斥并允许幂等释放', () => {
    resetFriendTaskCoordinator();
    const patrol = tryAcquireFriendTask('patrol');
    assert.ok(patrol);
    assert.equal(tryAcquireFriendTask('rain-poetry'), null);
    patrol.release();
    patrol.release();
    const rain = tryAcquireFriendTask('rain-poetry');
    assert.ok(rain);
    rain.release();
});
