const assert = require('node:assert/strict');
const test = require('node:test');
const {
    effectiveMinLevel,
    evaluateHarvestStealFilter,
    evaluateLevelFilter,
    isHarvestStealFilterEnabled,
} = require('../src/services/friend-application-filter');

function config(overrides = {}) {
    return {
        minLevel: 10,
        requireOwnLevel: false,
        ownLevel: 20,
        harvestStealEnabled: true,
        harvestPart: 8,
        stealPart: 1,
        ...overrides,
    };
}

test('好友申请等级门槛可选择同时受自身等级约束', () => {
    assert.equal(effectiveMinLevel(config()), 10);
    assert.equal(effectiveMinLevel(config({ requireOwnLevel: true })), 20);
    assert.deepEqual(evaluateLevelFilter(19, config({ requireOwnLevel: true })), {
        action: 'reject',
        reason: '等级 19 < 20',
    });
    assert.deepEqual(evaluateLevelFilter(20, config({ requireOwnLevel: true })), { action: 'accept' });
});

test('好友申请收偷比使用整数交叉相乘并允许从未偷取的玩家', () => {
    assert.equal(isHarvestStealFilterEnabled(config()), true);
    assert.deepEqual(evaluateHarvestStealFilter(7, 1, config()), {
        action: 'reject',
        reason: '收偷比 7:1 低于 8:1',
    });
    assert.deepEqual(evaluateHarvestStealFilter(16, 2, config()), { action: 'accept' });
    assert.deepEqual(evaluateHarvestStealFilter(0, 0, config()), { action: 'accept' });
    assert.deepEqual(
        evaluateHarvestStealFilter(0, 10, config({ harvestStealEnabled: false })),
        { action: 'accept' },
    );
});

export {};
