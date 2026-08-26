const assert = require('node:assert/strict');
const test = require('node:test');
const { registerAccountRoutes } = require('../src/controllers/admin-routes/accounts');

function createRouteHarness(provider) {
    const handlers = new Map();
    const app = {};
    for (const method of ['get', 'post', 'delete']) {
        app[method] = (path, ...routeHandlers) => {
            handlers.set(`${method.toUpperCase()} ${path}`, routeHandlers.at(-1));
            return app;
        };
    }
    registerAccountRoutes({
        addOrUpdateAccount: value => value,
        app,
        checkAccountAccess: (_request, accountId) => String(accountId) !== 'forbidden',
        deleteAccount: () => ({}),
        findAccountByRef: () => null,
        getAccessibleAccountIds: () => ['1', '2'],
        getAccountList: () => [],
        provider,
        resolveAccountId: value => String(value || ''),
        userStore: {},
        wxLoginAdapter: {},
    });
    return handlers.get('GET /api/account-logs');
}

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

test('账号动态接口使用当前账号范围后再传递 limit', () => {
    const calls = [];
    const handler = createRouteHarness({
        getAccountLogs: (...args) => {
            calls.push(args);
            return [{ accountId: '1', msg: 'own' }];
        },
    });
    const response = responseRecorder();
    handler({
        currentUser: { username: 'alice' },
        headers: { 'x-account-id': '1' },
        query: { limit: '20' },
    }, response);

    assert.deepEqual(calls, [['1', 20]]);
    assert.deepEqual(response.payload, [{ accountId: '1', msg: 'own' }]);
});

test('账号动态接口保留无账号范围调用并继续执行用户权限过滤', () => {
    const calls = [];
    const handler = createRouteHarness({
        getAccountLogs: (...args) => {
            calls.push(args);
            return [
                { accountId: '1', msg: 'own' },
                { accountId: '3', msg: 'foreign' },
            ];
        },
    });
    const response = responseRecorder();
    handler({
        currentUser: { username: 'alice' },
        headers: {},
        query: { limit: '10' },
    }, response);

    assert.deepEqual(calls, [[10]]);
    assert.deepEqual(response.payload, [{ accountId: '1', msg: 'own' }]);
});

test('账号动态接口拒绝越权指定账号', () => {
    const handler = createRouteHarness({ getAccountLogs: () => [] });
    const response = responseRecorder();
    handler({
        currentUser: { username: 'alice' },
        headers: { 'x-account-id': 'forbidden' },
        query: {},
    }, response);

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.payload, { ok: false, error: '无权访问此账号' });
});

export {};
