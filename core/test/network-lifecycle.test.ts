const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { after, afterEach, before, test } = require('node:test');

const wsModulePath = require.resolve('ws');
const originalWebSocket = require(wsModulePath);
const originalLoginTimeout = process.env.FARM_LOGIN_TIMEOUT_MS;
process.env.FARM_LOGIN_TIMEOUT_MS = '25';

class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url, options) {
        super();
        this.url = url;
        this.options = options;
        this.readyState = FakeWebSocket.OPEN;
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }

    send(payload, callback) {
        this.sent.push(payload);
        queueMicrotask(() => callback && callback(null));
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
    }
}

require.cache[wsModulePath].exports = FakeWebSocket;
const networkModulePath = require.resolve('../src/utils/network');
delete require.cache[networkModulePath];
const { loadProto } = require('../src/utils/proto');
const network = require('../src/utils/network');

before(async () => {
    await loadProto();
});

afterEach(() => {
    network.cleanup('测试清理');
    FakeWebSocket.instances = [];
});

after(() => {
    network.cleanup('测试结束');
    require.cache[wsModulePath].exports = originalWebSocket;
    delete require.cache[networkModulePath];
    if (originalLoginTimeout === undefined) delete process.env.FARM_LOGIN_TIMEOUT_MS;
    else process.env.FARM_LOGIN_TIMEOUT_MS = originalLoginTimeout;
});

function connectFake() {
    network.connect('test-code', () => {});
    return FakeWebSocket.instances.at(-1);
}

async function waitForSent(socket, count = 1) {
    const deadline = Date.now() + 200;
    while (socket.sent.length < count && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(socket.sent.length >= count, `expected ${count} sent frame(s)`);
}

test('请求超时会释放请求槽并允许后续请求进入', async () => {
    connectFake();

    await assert.rejects(
        network.sendMsgAsync('TestService', 'First', Buffer.alloc(0), { timeoutMs: 5, category: 'control' }),
        error => error && error.code === 'REQUEST_TIMEOUT',
    );

    await assert.rejects(
        network.sendMsgAsync('TestService', 'Second', Buffer.alloc(0), { timeoutMs: 5, category: 'control' }),
        error => error && error.code === 'REQUEST_TIMEOUT',
    );
});

test('业务请求槽满时错误包含活跃请求与入站诊断', async () => {
    connectFake();
    const pending = ['One', 'Two', 'Three', 'Four', 'Five'].map(method => (
        network.sendMsgAsync('TestService', method, Buffer.alloc(0), { timeoutMs: 1000, category: 'control' })
    ));
    const rejections = pending.map(request => assert.rejects(request, /请求已中断: 诊断测试清理/));
    await new Promise(resolve => setImmediate(resolve));

    await assert.rejects(
        network.sendMsgAsync('TestService', 'Overflow', Buffer.alloc(0), { timeoutMs: 1000, category: 'control' }),
        error => /请求队列已满: Overflow/.test(error.message)
            && /active=.*One/.test(error.message)
            && /lastInbound=\d+ms/.test(error.message),
    );

    network.cleanup('诊断测试清理');
    await Promise.all(rejections);
});

test('网络清理会拒绝全部在途请求并清除超时任务', async () => {
    connectFake();
    const pending = network.sendMsgAsync('TestService', 'Pending', Buffer.alloc(0), { timeoutMs: 1000, category: 'control' });
    const rejection = assert.rejects(pending, /请求已中断: 主动测试/);
    await new Promise(resolve => setImmediate(resolve));

    network.cleanup('主动测试');

    await rejection;
});

test('主动重连会隔离旧连接事件并中断旧连接请求', async () => {
    const oldSocket = connectFake();
    const oldPending = network.sendMsgAsync('TestService', 'OldRequest', Buffer.alloc(0), { timeoutMs: 1000, category: 'control' });
    const oldRejection = assert.rejects(oldPending, /请求已中断: 主动重连/);
    await new Promise(resolve => setImmediate(resolve));

    network.reconnect('new-code');
    await oldRejection;
    const newSocket = FakeWebSocket.instances.at(-1);
    assert.notEqual(newSocket, oldSocket);
    assert.equal(oldSocket.listenerCount('message'), 0);

    let newSettled = false;
    const newPending = network.sendMsgAsync('TestService', 'NewRequest', Buffer.alloc(0), { timeoutMs: 1000, category: 'control' });
    newPending.then(() => { newSettled = true; }, () => { newSettled = true; });
    oldSocket.emit('message', Buffer.from([0]));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(newSettled, false);

    const newRejection = assert.rejects(newPending, /请求已中断: 测试结束新请求/);
    network.cleanup('测试结束新请求');
    await newRejection;
});

test('认证完成前业务请求立即失败且状态不伪装在线', async () => {
    connectFake();

    assert.equal(network.getConnectionState().phase, 'connecting');
    assert.equal(network.getConnectionState().ready, false);
    await assert.rejects(
        network.sendMsgAsync('TestService', 'Business', Buffer.alloc(0), 1000),
        error => error?.code === 'CONNECTION_NOT_READY' && /phase=connecting/.test(error.message),
    );
});

test('Login 无回包会在截止时间后关闭旧连接并进入退避', async () => {
    const socket = connectFake();
    socket.emit('open');
    assert.equal(network.getConnectionState().phase, 'authenticating');

    await new Promise(resolve => setTimeout(resolve, 45));

    const state = network.getConnectionState();
    assert.equal(state.phase, 'backoff');
    assert.equal(state.ready, false);
    assert.equal(state.reconnectAttempt, 1);
    assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});

test('每次重连会重置协议序号和服务端序号', async () => {
    const { decodeMessage, encodeMessage } = require('../src/utils/proto');
    const oldSocket = connectFake();
    oldSocket.emit('open');
    await waitForSent(oldSocket);
    oldSocket.emit('message', encodeMessage('GateMessage', {
        meta: { message_type: 3, server_seq: 99 },
        body: Buffer.alloc(0),
    }));

    network.reconnect('next-code');
    const newSocket = FakeWebSocket.instances.at(-1);
    newSocket.emit('open');
    await waitForSent(newSocket);

    const loginRequest = decodeMessage('GateMessage', newSocket.sent[0]);
    assert.equal(Number(loginRequest.meta.client_seq), 1);
    assert.equal(Number(loginRequest.meta.server_seq), 0);
});

test('重连退避随失败次数增长并封顶一分钟', () => {
    assert.equal(network.computeReconnectDelayMs(1, () => 0), 1600);
    assert.equal(network.computeReconnectDelayMs(2, () => 0.5), 5000);
    assert.equal(network.computeReconnectDelayMs(99, () => 1), 60000);
});
export {};
