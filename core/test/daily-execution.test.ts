const assert = require('node:assert/strict');
const test = require('node:test');
const { createDailyExecutionGate } = require('../src/services/daily-execution');

test('每日执行门闩同日去重、跨日放行并在忙碌时安排重试', () => {
    let dateKey = '2026-08-22';
    let retryCount = 0;
    const gate = createDailyExecutionGate(() => dateKey);
    const scheduleRetry = () => { retryCount += 1; };

    assert.equal(gate.tryStart(false, scheduleRetry), true);
    assert.equal(gate.tryStart(false, scheduleRetry), false);

    dateKey = '2026-08-23';
    assert.equal(gate.tryStart(true, scheduleRetry), false);
    assert.equal(retryCount, 1);
    assert.equal(gate.tryStart(false, scheduleRetry), true);
    assert.equal(gate.tryStart(false, scheduleRetry), false);
});

export {};
