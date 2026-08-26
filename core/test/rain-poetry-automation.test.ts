const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_ACCOUNT_CONFIG, normalizeAccountConfig } = require('../src/models/account-config');
const { planRainPoetryAutomation } = require('../src/runtime/rain-poetry-policy');
const { createWorkerRainPoetryRuntime } = require('../src/runtime/worker-rain-poetry');

function activity(overrides: any = {}) {
    return {
        active: true,
        balances: { collectionBottle: '0' },
        weather: { active: false },
        actions: { thunderstorm: { enabled: false } },
        exchangeItems: [],
        researchNodes: [],
        tasks: [],
        ...overrides,
    };
}

function fakeScheduler() {
    const tasks = new Map();
    return {
        tasks,
        clear(name) { return tasks.delete(name); },
        clearAll() { tasks.clear(); },
        getSnapshot() { return {}; },
        getTaskNames() { return [...tasks.keys()]; },
        has(name) { return tasks.has(name); },
        setTimeoutTask(name, delay, task) {
            tasks.set(name, { kind: 'timeout', delay, task });
            return {};
        },
        setIntervalTask(name, delay, task) {
            tasks.set(name, { kind: 'interval', delay, task });
            return {};
        },
    };
}

function runtimeFixture(options: any = {}) {
    let current = Object.prototype.hasOwnProperty.call(options, 'current') ? options.current : activity();
    let enabled = options.enabled !== false;
    let observer = null;
    const visits = [];
    const logs = [];
    const scheduler = fakeScheduler();
    const service = {
        async getCurrentRainPoetryActivity() { return current; },
        async exchangeRainBottle() { return { snapshot: { rainPoetry: current } }; },
        async unlockRainResearch() { return { snapshot: { rainPoetry: current } }; },
        async useRainThunderstorm() { return { snapshot: { rainPoetry: current } }; },
        async collectRainWeatherFromVisit(gid) {
            current = activity({ ...current, balances: { ...current.balances, collectionBottle: '0' } });
            return { friendGid: gid };
        },
        ...options.service,
    };
    const runtime = createWorkerRainPoetryRuntime({
        getAutomation: () => ({ rain_poetry_auto: enabled }),
        isLifecycleActive: () => options.lifecycle !== false,
        log: (...args) => logs.push(args),
        now: () => options.now ?? 1000000,
        scheduler,
        service,
        friend: {
            getBlacklist: () => options.blacklist || [],
            inQuietHours: () => !!options.quiet,
            list: async () => options.friends || [],
            normalizeWeather: value => value,
            randomDelay: async () => undefined,
            registerObserver: value => {
                observer = value;
                return () => { observer = null; };
            },
            tryAcquireTask: () => options.busy ? null : { owner: 'rain-poetry', release() {} },
            visit: async (entry) => {
                visits.push(entry.gid);
                if (observer) {
                    await observer({
                        source: 'rain-fallback',
                        friendGid: String(entry.gid),
                        friendName: entry.name,
                        enterReply: { weather_status: entry.weather },
                    });
                }
            },
        },
    });
    return {
        logs,
        runtime,
        scheduler,
        service,
        visits,
        getObserver: () => observer,
        setEnabled: value => { enabled = value; },
        setCurrent: value => { current = value; },
    };
}

test('雨落自动化配置对旧账号默认开启', () => {
    assert.equal(DEFAULT_ACCOUNT_CONFIG.automation.rain_poetry_auto, true);
    assert.equal(normalizeAccountConfig({ automation: {} }).automation.rain_poetry_auto, true);
});

test('纯策略只根据快照生成兑换、研究、召唤和扫描计划', () => {
    const plan = planRainPoetryAutomation(activity({
        balances: { collectionBottle: '2' },
        actions: { thunderstorm: { enabled: true } },
        tasks: [{ itemId: '5002', progress: '1', target: '10', completed: false }],
        exchangeItems: [{ id: '200', available: true, item: { id: '5001' } }],
        researchNodes: [
            { id: '1000', unlockable: true, claimed: false },
            { id: '1001', unlockable: false, claimed: false },
        ],
    }));
    assert.deepEqual(plan, {
        active: true,
        collectionBottleCount: 2n,
        exchangeGoodsId: '200',
        researchNodeIds: ['1000'],
        shouldScanFriends: true,
        useThunderstorm: true,
    });
    assert.equal(planRainPoetryAutomation(null).active, false);
});

test('仅在召唤或闪电变异任务尚未完成时自动使用雷雨召唤瓶', () => {
    const enabled = { thunderstorm: { enabled: true } };
    const plan = (tasks: any[]) => planRainPoetryAutomation(activity({ actions: enabled, tasks })).useThunderstorm;

    assert.equal(plan([]), false);
    assert.equal(plan([{ itemId: '5002', progress: '10', target: '10', completed: true }]), false);
    assert.equal(plan([{ itemId: '5002', progress: '10', target: '10', completed: false }]), false);
    assert.equal(plan([{ itemId: '5002', progress: '0', target: '0', completed: false }]), false);
    assert.equal(plan([{ itemId: '5001', name: '使用天气采集瓶', progress: '0', target: '10', completed: false }]), false);
    assert.equal(plan([{ itemId: '5002', progress: '9', target: '10', completed: false }]), true);
    assert.equal(plan([{ itemId: '29003', name: '收获闪电变异作物', progress: '3', target: '10', completed: false }]), true);
});

test('已有好友巡查会话可直接采集天气，不发起额外好友访问', async () => {
    let collectArgs = null;
    const snapshot = activity({ balances: { collectionBottle: '1' } });
    const fixture = runtimeFixture({
        current: snapshot,
        service: {
            async collectRainWeatherFromVisit(...args) {
                collectArgs = args;
                return { rainPoetry: activity({ balances: { collectionBottle: '0' } }) };
            },
        },
    });
    fixture.runtime.start();
    await fixture.runtime.checkNow('test-init');
    const observer = fixture.getObserver();
    await observer({
        source: 'steal', friendGid: '101', friendName: '好友A',
        enterReply: { weather_status: { thunderstorm: true } },
    });
    assert.equal(fixture.visits.length, 0);
    assert.equal(collectArgs[0], '101');
    assert.deepEqual(collectArgs[1], { weather_status: { thunderstorm: true } });
    fixture.runtime.stop();
});

test('好友会话内的原始采集回包会本地扣减瓶子并在离开后刷新', async () => {
    let collects = 0;
    const fixture = runtimeFixture({
        current: activity({ balances: { collectionBottle: '1' } }),
        service: {
            async collectRainWeatherFromVisit() {
                collects += 1;
                return { success: true };
            },
        },
    });
    fixture.runtime.start();
    await fixture.runtime.checkNow('test-init');
    const observer = fixture.getObserver();
    const visit = {
        source: 'steal', friendGid: '101', friendName: '好友A',
        enterReply: { weather_status: { thunderstorm: true } },
    };
    await observer(visit);
    await observer({ ...visit, friendGid: '102', friendName: '好友B' });
    assert.equal(collects, 1);
    assert.equal(fixture.scheduler.has('rain_poetry_after_collect'), true);
    fixture.runtime.stop();
});

test('兜底扫描跳过近期已检查好友并覆盖普通巡查未进入的好友', async () => {
    const fixture = runtimeFixture({
        current: activity({ balances: { collectionBottle: '0' } }),
        friends: [
            { gid: 101, name: '好友A', weather: { thunderstorm: false } },
            { gid: 102, name: '好友B', weather: { thunderstorm: true } },
        ],
    });
    fixture.runtime.start();
    await fixture.runtime.checkNow('test-init');
    await fixture.getObserver()({
        source: 'help', friendGid: '101', friendName: '好友A',
        enterReply: { weather_status: { thunderstorm: false } },
    });
    fixture.setCurrent(activity({ balances: { collectionBottle: '1' } }));
    await fixture.runtime.checkNow('test-scan');
    assert.deepEqual(fixture.visits, [102]);
    fixture.runtime.stop();
});

test('好友任务占用时安排五分钟重试', async () => {
    const fixture = runtimeFixture({
        busy: true,
        current: activity({ balances: { collectionBottle: '1' } }),
        friends: [{ gid: 101, name: '好友A', weather: { thunderstorm: false } }],
    });
    fixture.runtime.start();
    assert.equal(await fixture.runtime.checkNow('busy-test'), 'busy');
    const retry = fixture.scheduler.tasks.get('rain_poetry_busy_retry');
    assert.equal(retry.kind, 'timeout');
    assert.equal(retry.delay, 5 * 60 * 1000);
    fixture.runtime.stop();
});

test('运行时注册三十分钟轮询并支持开关热启停', async () => {
    let reads = 0;
    const fixture = runtimeFixture({
        service: {
            async getCurrentRainPoetryActivity() {
                reads += 1;
                return activity();
            },
        },
    });
    fixture.runtime.start();
    const poll = fixture.scheduler.tasks.get('rain_poetry_poll');
    assert.equal(poll.kind, 'interval');
    assert.equal(poll.delay, 30 * 60 * 1000);
    await poll.task();
    assert.equal(reads, 1);

    fixture.setEnabled(false);
    fixture.runtime.stop();
    assert.equal(fixture.scheduler.has('rain_poetry_poll'), false);
    assert.equal(fixture.getObserver(), null);

    fixture.setEnabled(true);
    fixture.runtime.start();
    assert.notEqual(fixture.getObserver(), null);
    assert.equal(await fixture.runtime.checkNow('config-enabled'), 'completed');
    assert.equal(reads, 2);
    fixture.runtime.stop();
});

test('自动循环按兑换、逐级研究、召唤和采集顺序推进', async () => {
    const calls: string[] = [];
    const afterExchange = activity({
        balances: { collectionBottle: '1' },
        exchangeItems: [],
        actions: { thunderstorm: { enabled: true } },
        tasks: [{ itemId: '5002', progress: '0', target: '10', completed: false }],
        researchNodes: [{ id: '1000', unlockable: true, claimed: false }],
    });
    const afterFirstResearch = activity({
        ...afterExchange,
        researchNodes: [
            { id: '1000', unlockable: false, claimed: true },
            { id: '1001', unlockable: true, claimed: false },
        ],
    });
    const afterSecondResearch = activity({
        ...afterExchange,
        researchNodes: [
            { id: '1000', unlockable: false, claimed: true },
            { id: '1001', unlockable: false, claimed: true },
        ],
    });
    const fixture = runtimeFixture({
        current: activity({
            balances: { collectionBottle: '0' },
            exchangeItems: [{ id: '200', available: true, item: { id: '5001' } }],
        }),
        service: {
            async exchangeRainBottle() {
                calls.push('exchange');
                return { snapshot: { rainPoetry: afterExchange } };
            },
            async unlockRainResearch(nodeId) {
                calls.push(`research:${nodeId}`);
                return { snapshot: { rainPoetry: nodeId === '1000' ? afterFirstResearch : afterSecondResearch } };
            },
            async useRainThunderstorm() {
                calls.push('thunderstorm');
                return { snapshot: { rainPoetry: activity({ ...afterSecondResearch, actions: { thunderstorm: { enabled: false } } }) } };
            },
        },
    });
    fixture.runtime.start();
    assert.equal(await fixture.runtime.checkNow('ordered'), 'completed');
    assert.deepEqual(calls, ['exchange', 'research:1000', 'research:1001', 'thunderstorm']);
    fixture.runtime.stop();
});

test('写操作未带回快照时补读最新活动状态而不沿用旧计划', async () => {
    let reads = 0;
    const beforeExchange = activity({
        balances: { collectionBottle: '0' },
        exchangeItems: [{ id: '200', available: true, item: { id: '5001' } }],
    });
    const afterExchange = activity({
        balances: { collectionBottle: '1' },
        exchangeItems: [],
    });
    const fixture = runtimeFixture({
        current: beforeExchange,
        friends: [{ gid: 101, name: '好友A', weather: { thunderstorm: false } }],
        service: {
            async getCurrentRainPoetryActivity() {
                reads += 1;
                return reads === 1 ? beforeExchange : afterExchange;
            },
            async exchangeRainBottle() {
                return { snapshot: null, snapshotError: 'temporary read failure' };
            },
        },
    });

    fixture.runtime.start();
    assert.equal(await fixture.runtime.checkNow('missing-snapshot'), 'completed');
    assert.equal(reads, 2);
    assert.deepEqual(fixture.visits, [101]);
    fixture.runtime.stop();
});

test('多个采集瓶会继续扫描不同雷雨好友并遵守黑名单', async () => {
    let remaining = 2;
    const collected: string[] = [];
    const fixture = runtimeFixture({
        blacklist: [103],
        current: activity({ balances: { collectionBottle: '2' } }),
        friends: [
            { gid: 101, name: '好友A', weather: { thunderstorm: true } },
            { gid: 102, name: '好友B', weather: { thunderstorm: true } },
            { gid: 103, name: '好友C', weather: { thunderstorm: true } },
        ],
        service: {
            async collectRainWeatherFromVisit(gid) {
                collected.push(String(gid));
                remaining -= 1;
                return { rainPoetry: activity({ balances: { collectionBottle: String(remaining) } }) };
            },
        },
    });
    fixture.runtime.start();
    assert.equal(await fixture.runtime.checkNow('multi-bottle'), 'completed');
    assert.deepEqual(fixture.visits, [101, 102]);
    assert.deepEqual(collected, ['101', '102']);
    fixture.runtime.stop();
});

test('兜底扫描完成后统一刷新活动快照，不在好友会话内追加刷新任务', async () => {
    let reads = 0;
    const fixture = runtimeFixture({
        current: activity({ balances: { collectionBottle: '1' } }),
        friends: [{ gid: 101, name: '好友A', weather: { thunderstorm: true } }],
        service: {
            async getCurrentRainPoetryActivity() {
                reads += 1;
                return activity({ balances: { collectionBottle: reads === 1 ? '1' : '0' } });
            },
            async collectRainWeatherFromVisit() {
                return { success: true };
            },
        },
    });
    fixture.runtime.start();
    assert.equal(await fixture.runtime.checkNow('fallback-refresh'), 'completed');
    assert.equal(reads, 2);
    assert.equal(fixture.scheduler.has('rain_poetry_after_collect'), false);
    fixture.runtime.stop();
});

test('兜底扫描对重复好友去重，好友巡查关闭也不影响独立扫描', async () => {
    let remaining = 1;
    const fixture = runtimeFixture({
        current: activity({ balances: { collectionBottle: '1' } }),
        friends: [
            { gid: 101, name: '好友A', weather: { thunderstorm: true } },
            { gid: 101, name: '好友A重复项', weather: { thunderstorm: true } },
        ],
        service: {
            async collectRainWeatherFromVisit() {
                remaining -= 1;
                return { rainPoetry: activity({ balances: { collectionBottle: String(remaining) } }) };
            },
        },
    });
    fixture.runtime.start();
    await fixture.runtime.checkNow('dedupe');
    assert.deepEqual(fixture.visits, [101]);
    fixture.runtime.stop();
});

test('雷雨好友采集失败不会进入近期去重，下一轮仍可重试', async () => {
    let attempts = 0;
    const fixture = runtimeFixture({
        current: activity({ balances: { collectionBottle: '1' } }),
        friends: [{ gid: 101, name: '好友A', weather: { thunderstorm: true } }],
        service: {
            async collectRainWeatherFromVisit() {
                attempts += 1;
                if (attempts === 1) throw new Error('temporary failure');
                return { rainPoetry: activity({ balances: { collectionBottle: '0' } }) };
            },
        },
    });
    fixture.runtime.start();
    await fixture.runtime.checkNow('first-attempt');
    await fixture.runtime.checkNow('retry-attempt');
    assert.equal(attempts, 2);
    assert.deepEqual(fixture.visits, [101, 101]);
    fixture.runtime.stop();
});

test('同一账号的并发触发复用一个在途活动循环', async () => {
    let resolveSnapshot;
    let reads = 0;
    const snapshotPromise = new Promise(resolve => { resolveSnapshot = resolve; });
    const fixture = runtimeFixture({
        service: {
            async getCurrentRainPoetryActivity() {
                reads += 1;
                return snapshotPromise;
            },
        },
    });
    fixture.runtime.start();
    const first = fixture.runtime.checkNow('login');
    const second = fixture.runtime.checkNow('poll');
    assert.equal(first, second);
    resolveSnapshot(activity());
    assert.equal(await first, 'completed');
    assert.equal(reads, 1);
    fixture.runtime.stop();
});

test('关闭自动化或 Worker 生命周期结束时不注册活动任务', async () => {
    const disabled = runtimeFixture({ enabled: false });
    disabled.runtime.start();
    assert.equal(disabled.getObserver(), null);
    assert.equal(await disabled.runtime.checkNow('disabled'), 'disabled');
    assert.equal(disabled.scheduler.has('rain_poetry_poll'), false);

    const stopped = runtimeFixture({ lifecycle: false });
    stopped.runtime.start();
    assert.equal(stopped.getObserver(), null);
    assert.equal(await stopped.runtime.checkNow('stopped'), 'stopped');
});

test('活动不存在时暂停操作但保留发现轮询，活动开放后自动恢复', async () => {
    const fixture = runtimeFixture({ current: null });
    fixture.runtime.start();
    assert.equal(await fixture.runtime.checkNow('inactive'), 'inactive');
    assert.equal(fixture.scheduler.has('rain_poetry_poll'), true);
    assert.equal(fixture.getObserver(), null);
    await fixture.runtime.checkNow('inactive-again');
    assert.equal(fixture.logs.filter(args => String(args[1]).includes('自动操作已暂停')).length, 1);

    fixture.setCurrent(activity());
    const poll = fixture.scheduler.tasks.get('rain_poetry_poll');
    assert.equal(await poll.task(), 'completed');
    assert.notEqual(fixture.getObserver(), null);
    assert.equal(fixture.logs.filter(args => String(args[1]).includes('自动操作已暂停')).length, 1);
    fixture.runtime.stop();
});
