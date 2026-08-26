const assert = require('node:assert/strict');
const test = require('node:test');
const { createDataProvider } = require('../src/runtime/data-provider');
const { createRuntimeState, resolveLogLevel } = require('../src/runtime/runtime-state');

function runtimeState() {
    return createRuntimeState({ store: {} });
}

test('日志筛选支持模块、事件、多关键词、开发标记和时间范围组合', () => {
    const state = runtimeState();
    const logs = [
        {
            id: 'match',
            ts: Date.parse('2026-08-26T10:00:00+08:00'),
            tag: '活动',
            msg: '雨落成诗已从好友采集雷雨天气',
            meta: { module: 'rain-poetry', event: 'auto_collect' },
            _searchText: '雨落成诗 好友 雷雨 rain-poetry auto_collect',
        },
        {
            id: 'dev',
            ts: Date.parse('2026-08-26T10:01:00+08:00'),
            tag: '活动',
            msg: '雨落成诗好友调试',
            meta: { module: 'rain-poetry', event: 'auto_collect', dev: true },
            _searchText: '雨落成诗 好友 调试',
        },
        {
            id: 'other',
            ts: Date.parse('2026-08-26T10:02:00+08:00'),
            tag: '农场',
            msg: '好友雷雨',
            meta: { module: 'farm', event: 'farm_cycle' },
        },
    ];

    const result = state.filterLogs(logs, {
        module: 'rain-poetry',
        event: 'auto_collect',
        keyword: '雨落成诗 好友',
        hideDev: true,
        timeFrom: '2026-08-26T09:59:00+08:00',
        timeTo: '2026-08-26T10:01:30+08:00',
    });
    assert.deepEqual(result.map(entry => entry.id), ['match']);
});

test('日志等级优先使用 level 并兼容错误标签与 isWarn', () => {
    const state = runtimeState();
    const logs = [
        { id: 'info', tag: '系统', level: 'info' },
        { id: 'warn', tag: '系统', isWarn: true },
        { id: 'error', tag: '错误' },
        { id: 'explicit-error', tag: '系统', level: 'error', isWarn: false },
    ];

    assert.equal(resolveLogLevel(logs[0]), 'info');
    assert.equal(resolveLogLevel(logs[1]), 'warn');
    assert.equal(resolveLogLevel(logs[2]), 'error');
    assert.deepEqual(state.filterLogs(logs, { level: 'info' }).map(entry => entry.id), ['info']);
    assert.deepEqual(state.filterLogs(logs, { level: 'warn' }).map(entry => entry.id), ['warn']);
    assert.deepEqual(state.filterLogs(logs, { level: 'error' }).map(entry => entry.id), ['error', 'explicit-error']);
    assert.deepEqual(state.filterLogs(logs, { isWarn: false }).map(entry => entry.id), ['info']);
    assert.deepEqual(state.filterLogs(logs, { isWarn: true }).map(entry => entry.id), ['warn', 'error', 'explicit-error']);
});

test('主进程错误日志写入显式等级和兼容警告标记', () => {
    const state = runtimeState();
    state.log('错误', '启动失败');
    assert.equal(state.globalLogs[0].level, 'error');
    assert.equal(state.globalLogs[0].isWarn, true);
});

test('账号动态先按账号过滤再截取最新数量', () => {
    const accountLogs = [
        { accountId: '1', msg: 'one-1' },
        { accountId: '2', msg: 'two-1' },
        { accountId: '1', msg: 'one-2' },
        { accountId: '2', msg: 'two-2' },
        { accountId: '1', msg: 'one-3' },
    ];
    const provider = createDataProvider({
        workers: {},
        globalLogs: [],
        accountLogs,
        getAccounts: () => ({ accounts: [{ id: '1' }, { id: '2' }] }),
    });

    assert.deepEqual(provider.getAccountLogs('1', 2).map(entry => entry.msg), ['one-3', 'one-2']);
    assert.deepEqual(provider.getAccountLogs(3).map(entry => entry.msg), ['one-3', 'two-2', 'one-2']);
});

export {};
