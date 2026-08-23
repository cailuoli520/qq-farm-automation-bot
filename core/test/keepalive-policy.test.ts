const test = require('node:test');
const assert = require('node:assert/strict');
const {
    HEARTBEAT_STALE_AFTER_MS,
    MAX_HEARTBEAT_MISSES,
    shouldReconnectForHeartbeat,
} = require('../src/utils/keepalive-policy');

test('心跳策略容忍瞬时卡顿，仅在连续失败且无入站数据时重连', () => {
    assert.equal(MAX_HEARTBEAT_MISSES, 3);
    assert.equal(HEARTBEAT_STALE_AFTER_MS, 30_000);
    assert.equal(shouldReconnectForHeartbeat(2, 120_000), false);
    assert.equal(shouldReconnectForHeartbeat(3, 30_000), false);
    assert.equal(shouldReconnectForHeartbeat(3, 30_001), true);
    assert.equal(shouldReconnectForHeartbeat(8, 1_000), false);
});

export {};
