const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createWorkerManager, workerApiTimeout } = require('../src/runtime/worker-manager');

class FakeScheduler {
    tasks: Map<string, any>;

    constructor() {
        this.tasks = new Map();
    }

    clear(name) {
        return this.tasks.delete(String(name));
    }

    clearAll() {
        this.tasks.clear();
    }

    setTimeoutTask(name, delayMs, task) {
        this.tasks.set(String(name), { kind: 'timeout', delayMs, task });
        return name;
    }

    setIntervalTask(name, delayMs, task) {
        this.tasks.set(String(name), { kind: 'interval', delayMs, task });
        return name;
    }

    async run(name) {
        const key = String(name);
        const entry = this.tasks.get(key);
        assert.ok(entry, `missing scheduled task: ${key}`);
        if (entry.kind === 'timeout') this.tasks.delete(key);
        return entry.task();
    }
}

class FakeWorker extends EventEmitter {
    static instances = [];

    constructor() {
        super();
        this.sent = [];
        this.terminated = false;
        FakeWorker.instances.push(this);
    }

    postMessage(payload) {
        this.sent.push(payload);
        if (payload.type === 'stop') {
            queueMicrotask(() => this.emit('exit', 0, null));
        }
    }

    terminate() {
        this.terminated = true;
        queueMicrotask(() => this.emit('exit', 1, 'SIGTERM'));
        return Promise.resolve();
    }
}

function createHarness(options: { offlineAutoDeleteMs?: number } = {}) {
    FakeWorker.instances = [];
    const scheduler = new FakeScheduler();
    const workers = {};
    const accountLogs = [];
    const deletedAccountIds = [];
    const account = { id: '12', name: '测试账号', platform: 'qq', code: 'login-code' };
    let now = 0;
    const manager = createWorkerManager({
        WorkerThread: FakeWorker,
        runtimeMode: 'thread',
        processRef: { env: {}, pkg: false },
        mainEntryPath: '',
        workerScriptPath: '',
        workers,
        globalLogs: [],
        log: () => {},
        addAccountLog: (action, msg, accountId, accountName, extra = {}) => {
            accountLogs.push({ action, msg, accountId, accountName, ...extra });
        },
        normalizeStatusForPanel: value => value,
        buildConfigSnapshotForAccount: () => ({ automation: {} }),
        getOfflineAutoDeleteMs: () => options.offlineAutoDeleteMs ?? Number.POSITIVE_INFINITY,
        triggerOfflineReminder: () => {},
        addOrUpdateAccount: () => {},
        deleteAccount: accountId => deletedAccountIds.push(accountId),
        getAutoRelogin: () => null,
        getAccounts: () => ({ accounts: [account] }),
        reauthRequiredStates: new Map(),
        scheduler,
        now: () => now,
    });
    return {
        account,
        manager,
        scheduler,
        workers,
        accountLogs,
        deletedAccountIds,
        advance(ms) { now += ms; },
    };
}

function settleEvents() {
    return new Promise(resolve => setImmediate(resolve));
}

test('新增多请求 API 使用覆盖完整请求链的主进程超时', () => {
    assert.equal(workerApiTimeout('getIllustratedSnapshot'), 90000);
    assert.equal(workerApiTimeout('getPetInfo'), 90000);
    assert.equal(workerApiTimeout('getPetProtectLogs'), 90000);
    assert.equal(workerApiTimeout('useDogFood'), 150000);
    assert.equal(workerApiTimeout('claimDogSkillGifts'), 150000);
    assert.equal(workerApiTimeout('setItemsLocked'), 150000);
    assert.equal(workerApiTimeout('deleteFriend'), 150000);
    assert.equal(workerApiTimeout('fertilizeOwnLand'), 150000);
    assert.equal(workerApiTimeout('getBag'), 10000);
});

test('Worker 启动只允许一个实例并发送启动与配置快照', () => {
    const harness = createHarness();

    assert.equal(harness.manager.startWorker(harness.account), true);
    assert.equal(harness.manager.startWorker(harness.account), false);
    assert.equal(FakeWorker.instances.length, 1);
    assert.deepEqual(FakeWorker.instances[0].sent.slice(0, 2), [
        { type: 'start', config: { code: 'login-code', platform: 'qq' } },
        { type: 'config_sync', config: { automation: {} } },
    ]);
    assert.deepEqual(harness.accountLogs.map(entry => entry.action), ['start']);
});

test('Worker 异常退出写入账号动态，正常停止不误报异常', async () => {
    const abnormal = createHarness();
    abnormal.manager.startWorker(abnormal.account);
    abnormal.workers[abnormal.account.id].process.emit('exit', 2, 'SIGABRT');
    assert.deepEqual(abnormal.accountLogs.map(entry => entry.action), ['start', 'unexpected_exit']);
    assert.equal(abnormal.accountLogs[1].reason, 'code=2, signal=SIGABRT');

    const normal = createHarness();
    normal.manager.startWorker(normal.account);
    normal.manager.stopWorker(normal.account.id);
    await settleEvents();
    assert.deepEqual(normal.accountLogs.map(entry => entry.action), ['start']);
});

test('停止和重启 Worker 会清理旧实例且只启动一个新实例', async () => {
    const harness = createHarness();
    harness.manager.startWorker(harness.account);
    const first = FakeWorker.instances[0];

    harness.manager.restartWorker(harness.account);
    assert.equal(first.sent.at(-1).type, 'stop');
    await settleEvents();

    assert.equal(FakeWorker.instances.length, 2);
    assert.equal(harness.workers[harness.account.id].process, FakeWorker.instances[1]);

    harness.manager.stopWorker(harness.account.id);
    await settleEvents();
    assert.equal(harness.workers[harness.account.id], undefined);
});

test('Worker API 回包会完成请求并清除超时任务', async () => {
    const harness = createHarness();
    harness.manager.startWorker(harness.account);
    const worker = harness.workers[harness.account.id];

    const resultPromise = harness.manager.callWorkerApi(harness.account.id, 'getBag', 1);
    const request = worker.process.sent.at(-1);
    assert.deepEqual(request, { type: 'api_call', id: 1, method: 'getBag', args: [1] });
    assert.equal(harness.scheduler.tasks.has('api_timeout_12_1'), true);

    worker.process.emit('message', { type: 'api_response', id: 1, result: { items: [] } });
    assert.deepEqual(await resultPromise, { items: [] });
    assert.equal(worker.requests.size, 0);
    assert.equal(harness.scheduler.tasks.has('api_timeout_12_1'), false);
});

test('Worker API 超时和进程退出都会拒绝并释放在途请求', async () => {
    const timeoutHarness = createHarness();
    timeoutHarness.manager.startWorker(timeoutHarness.account);
    const timeoutPromise = timeoutHarness.manager.callWorkerApi(timeoutHarness.account.id, 'getBag');
    const timeoutAssertion = assert.rejects(timeoutPromise, /API Timeout/);
    await timeoutHarness.scheduler.run('api_timeout_12_1');
    await timeoutAssertion;
    assert.equal(timeoutHarness.workers[timeoutHarness.account.id].requests.size, 0);

    const exitHarness = createHarness();
    exitHarness.manager.startWorker(exitHarness.account);
    const exitPromise = exitHarness.manager.callWorkerApi(exitHarness.account.id, 'getBag');
    const exitAssertion = assert.rejects(exitPromise, /Worker exited/);
    exitHarness.workers[exitHarness.account.id].process.emit('exit', 1, null);
    await exitAssertion;
    assert.equal(exitHarness.workers[exitHarness.account.id], undefined);
    assert.equal(exitHarness.scheduler.tasks.has('api_timeout_12_1'), false);
});

test('watchdog 每次重启后即使恢复登录，连续卡死仍最多自动重启三次', async () => {
    const harness = createHarness();
    harness.manager.startWorker(harness.account);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
        FakeWorker.instances.at(-1).emit('message', {
            type: 'status_sync',
            data: { connection: { connected: true, phase: 'ready' }, status: {} },
        });
        harness.advance(90000);
        await harness.scheduler.run('watchdog_12');
        if (attempt <= 3) {
            assert.equal(FakeWorker.instances.at(-1).terminated, true);
            await settleEvents();
            await harness.scheduler.run('watchdog_restart_12');
            await settleEvents();
            assert.ok(harness.workers[harness.account.id]);
        } else {
            assert.equal(FakeWorker.instances.at(-1).terminated, true);
            await settleEvents();
            assert.equal(harness.workers[harness.account.id], undefined);
            assert.equal(harness.scheduler.tasks.has('watchdog_restart_12'), false);
        }
    }

    assert.equal(FakeWorker.instances.length, 4);
});

test('watchdog 重启后持续健康十分钟才重置连续卡死计数', async () => {
    const harness = createHarness();
    harness.manager.startWorker(harness.account);

    harness.advance(90000);
    await harness.scheduler.run('watchdog_12');
    await settleEvents();
    await harness.scheduler.run('watchdog_restart_12');
    await settleEvents();

    const healthyWorker = FakeWorker.instances.at(-1);
    healthyWorker.emit('message', {
        type: 'status_sync',
        data: { connection: { connected: true, phase: 'ready' }, status: {} },
    });
    for (let index = 0; index < 20; index += 1) {
        harness.advance(30000);
        healthyWorker.emit('message', { type: 'pong' });
        await harness.scheduler.run('watchdog_12');
    }

    for (let attempt = 1; attempt <= 4; attempt += 1) {
        harness.advance(90000);
        await harness.scheduler.run('watchdog_12');
        if (attempt <= 3) {
            await settleEvents();
            await harness.scheduler.run('watchdog_restart_12');
            await settleEvents();
        }
    }

    assert.equal(FakeWorker.instances.length, 5);
    assert.equal(harness.workers[harness.account.id], undefined);
});

test('网关连续十分钟未恢复时由主进程重建 Worker', async () => {
    const harness = createHarness();
    harness.manager.startWorker(harness.account);
    const first = FakeWorker.instances[0];

    harness.advance(1);
    first.emit('message', {
        type: 'status_sync',
        data: { connection: { connected: false, phase: 'backoff' }, status: {} },
    });
    harness.advance(10 * 60 * 1000);
    first.emit('message', {
        type: 'status_sync',
        data: { connection: { connected: false, phase: 'backoff' }, status: {} },
    });

    assert.equal(first.terminated, true);
    assert.equal(harness.workers[harness.account.id], undefined);
    assert.equal(harness.accountLogs.at(-1).action, 'self_heal_restart');
    await settleEvents();
    await harness.scheduler.run('watchdog_restart_12');
    await settleEvents();
    assert.ok(harness.workers[harness.account.id]);
    assert.equal(harness.workers[harness.account.id].disconnectedSince, 1);
    assert.equal(harness.workers[harness.account.id].connectionStallSince, 0);
});

test('网络自愈重启保留连续离线计时，达到阈值后仍会自动删除账号', async () => {
    const harness = createHarness({ offlineAutoDeleteMs: 15 * 60 * 1000 });
    harness.manager.startWorker(harness.account);
    const first = FakeWorker.instances[0];

    harness.advance(1);
    first.emit('message', {
        type: 'status_sync',
        data: { connection: { connected: false, phase: 'backoff' }, status: {} },
    });
    harness.advance(10 * 60 * 1000);
    first.emit('message', {
        type: 'status_sync',
        data: { connection: { connected: false, phase: 'backoff' }, status: {} },
    });
    await settleEvents();
    await harness.scheduler.run('watchdog_restart_12');
    await settleEvents();

    const second = FakeWorker.instances.at(-1);
    second.emit('message', {
        type: 'status_sync',
        data: { connection: { connected: false, phase: 'backoff' }, status: {} },
    });
    harness.advance(5 * 60 * 1000);
    second.emit('message', {
        type: 'status_sync',
        data: { connection: { connected: false, phase: 'backoff' }, status: {} },
    });

    assert.deepEqual(harness.deletedAccountIds, ['12']);
    assert.equal(harness.accountLogs.at(-1).action, 'offline_delete');
    assert.equal(harness.scheduler.tasks.has('watchdog_restart_12'), false);
});

test('等待重新授权时不会触发长离线自愈重启', () => {
    const harness = createHarness();
    harness.manager.startWorker(harness.account);
    const worker = FakeWorker.instances[0];

    harness.advance(1);
    worker.emit('message', {
        type: 'status_sync',
        data: { connection: { connected: false, phase: 'reauth-required' }, status: {} },
    });
    harness.advance(20 * 60 * 1000);
    worker.emit('message', {
        type: 'status_sync',
        data: { connection: { connected: false, phase: 'reauth-required' }, status: {} },
    });

    assert.equal(worker.terminated, false);
    assert.ok(harness.workers[harness.account.id]);
});
export {};
