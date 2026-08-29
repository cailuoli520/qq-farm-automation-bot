const assert = require('node:assert/strict');
const test = require('node:test');
const { registerAccountRoutes } = require('../src/controllers/admin-routes/accounts');

function responseRecorder() {
    return {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        },
    };
}

function createUpdateHarness(existingAccount, wxLoginAdapter = {}) {
    const handlers = new Map();
    const savedPayloads = [];
    const app = {};
    for (const method of ['get', 'post', 'delete']) {
        app[method] = (path, ...routeHandlers) => {
            handlers.set(`${method.toUpperCase()} ${path}`, routeHandlers.at(-1));
            return app;
        };
    }

    const provider = {
        getAccounts: () => ({ accounts: [existingAccount], nextId: 41 }),
        isAccountRunning: () => false,
    };
    registerAccountRoutes({
        addOrUpdateAccount: (payload) => {
            savedPayloads.push(payload);
            return { accounts: [{ ...existingAccount, ...payload }], nextId: 41 };
        },
        app,
        checkAccountAccess: () => true,
        deleteAccount: () => ({}),
        findAccountByRef: () => existingAccount,
        getAccessibleAccountIds: () => [existingAccount.id],
        getAccountList: () => [existingAccount],
        provider,
        resolveAccountId: value => String(value || ''),
        userStore: {},
        wxLoginAdapter,
    });

    return {
        handler: handlers.get('POST /api/accounts'),
        savedPayloads,
    };
}

test('微信账号手动更新 Code 时保留原平台和名称', async () => {
    const existingAccount = {
        id: '40',
        name: '小雯',
        platform: 'wx',
        wxid: 'wx-openid',
    };
    const { handler, savedPayloads } = createUpdateHarness(existingAccount);
    const response = responseRecorder();

    await handler({
        body: {
            id: '40',
            name: '',
            code: 'fresh-wechat-code',
            platform: 'qq',
            loginType: 'manual',
        },
        currentUser: { role: 'admin', username: 'admin' },
        headers: {},
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(savedPayloads.length, 1);
    assert.deepEqual(savedPayloads[0], {
        id: '40',
        code: 'fresh-wechat-code',
        loginType: 'manual',
    });
});

test('有效微信扫码会话仍可显式切换账号平台', async () => {
    const existingAccount = {
        id: '40',
        name: '旧账号',
        platform: 'qq',
        wxid: '',
    };
    const consumed = [];
    const wxLoginAdapter = {
        peekPendingWxInfo: () => ({
            sessionId: 'pending-session',
            loginBuffer: 'login-buffer',
            refreshtoken: 'refresh-token',
            accesstoken: 'access-token',
        }),
        consumePendingWxInfo: (...args) => consumed.push(args),
        withAccountCredentialLock: (_wxid, _accountId, operation) => operation(),
    };
    const { handler, savedPayloads } = createUpdateHarness(existingAccount, wxLoginAdapter);
    const response = responseRecorder();

    await handler({
        body: {
            id: '40',
            name: '旧账号',
            code: 'fresh-wechat-code',
            platform: 'wx',
            loginType: 'wx_qr',
            wxid: 'new-wx-openid',
            wxSessionId: 'pending-session',
        },
        currentUser: { role: 'admin', username: 'admin' },
        headers: {},
    }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(savedPayloads.length, 1);
    assert.equal(savedPayloads[0].platform, 'wx');
    assert.equal(savedPayloads[0].wxid, 'new-wx-openid');
    assert.equal(savedPayloads[0].loginBuffer, 'login-buffer');
    assert.equal(savedPayloads[0].refreshtoken, 'refresh-token');
    assert.equal(savedPayloads[0].accesstoken, 'access-token');
    assert.equal(consumed.length, 1);
});

export {};
