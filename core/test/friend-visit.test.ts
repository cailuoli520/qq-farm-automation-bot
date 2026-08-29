const assert = require('node:assert/strict');
const test = require('node:test');
const {
    FriendVisitEnterError,
    registerFriendVisitObserver,
    withFriendVisit,
} = require('../src/services/friend-visit');
const {
    getActiveFriendTaskOwner,
    resetFriendTaskCoordinator,
    tryAcquireFriendTask,
    waitForFriendTaskLease,
} = require('../src/services/friend-task-coordinator');
const {
    clearFriendWeatherCache,
    getCachedFriendWeather,
    recordFriendWeatherVisit,
} = require('../src/services/friend-weather-cache');

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

test('手动天气任务等待自动好友任务释放后再取得访问权', async () => {
    resetFriendTaskCoordinator();
    const patrol = tryAcquireFriendTask('patrol');
    assert.ok(patrol);
    setTimeout(() => patrol.release(), 10);
    const manual = await waitForFriendTaskLease('manual-rain', 100, 2);
    assert.ok(manual);
    assert.equal(getActiveFriendTaskOwner(), 'manual-rain');
    manual.release();
});

test('好友天气缓存记录访问信息并在十分钟后过期', () => {
    clearFriendWeatherCache();
    const observed = recordFriendWeatherVisit({
        source: 'patrol',
        friendGid: '123',
        friendName: '好友甲',
        enterReply: {
            basic: { gid: 123, name: '好友甲', avatar_url: 'avatar' },
            weather_status: { active: true, weather_type: 2 },
            brief_dog_info: { dog_id: 90021 },
        },
    }, 1000);
    assert.equal(observed?.host.name, '好友甲');
    assert.equal(observed?.pet?.id, '90021');
    assert.equal(getCachedFriendWeather('123', 1000 + 599999)?.inspectedAt, 1000);
    assert.equal(getCachedFriendWeather('123', 1000 + 600001), null);
});

test('普通天气也写入缓存，避免下一轮重复访问好友', () => {
    clearFriendWeatherCache();
    const observed = recordFriendWeatherVisit({
        source: 'patrol',
        friendGid: '8899',
        friendName: '普通天气好友',
        enterReply: { basic: { gid: 8899, name: '普通天气好友' } },
    }, 2000);

    assert.equal(observed?.gid, '8899');
    assert.deepEqual(observed?.weatherStatus, {});
    assert.equal(getCachedFriendWeather('8899', 2001)?.inspectedAt, 2000);
});
