const assert = require('node:assert/strict');
const test = require('node:test');
const {
    canBypassHelpExpLimitForProtectDog,
    isProtectDog,
} = require('../src/services/friend');

test('只有启用策略且好友部署护主犬时才绕过帮助经验上限', () => {
    assert.equal(isProtectDog({ dog_id: 90021 }), true);
    assert.equal(isProtectDog({ dogId: 90021 }), true);
    assert.equal(isProtectDog({ dog_id: 90001 }), false);
    assert.equal(canBypassHelpExpLimitForProtectDog({ brief_dog_info: { dog_id: 90021 } }, true), true);
    assert.equal(canBypassHelpExpLimitForProtectDog({ briefDogInfo: { dogId: 90021 } }, true), true);
    assert.equal(canBypassHelpExpLimitForProtectDog({ brief_dog_info: { dog_id: 90021 } }, false), false);
    assert.equal(canBypassHelpExpLimitForProtectDog({ brief_dog_info: { dog_id: 90001 } }, true), false);
});

export {};
