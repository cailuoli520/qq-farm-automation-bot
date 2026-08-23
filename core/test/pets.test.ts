const assert = require('node:assert/strict');
const test = require('node:test');
const { buildPetSnapshot, didProtectDurationIncrease, MAX_PROTECT_DURATION_SECONDS } = require('../src/services/pets');

test('宠物快照以 owned 字段判断获得状态，并仅统计未锁定狗粮', () => {
    const result = buildPetSnapshot({
        current_dog_id: 90001,
        protect_time: 86400,
        dogs: [
            { id: 90001, name: '小狗', owned: 1 },
            { id: 90002, name: '大狗', status: 1 },
        ],
    }, {
        items: [
            { id: 90004, count: 3, locked: false },
            { id: 90004, count: 2, locked: true },
        ],
    });

    assert.equal(result.dogs.find((dog: any) => dog.id === 90001).owned, true);
    assert.equal(result.dogs.find((dog: any) => dog.id === 90002).owned, false);
    assert.equal(result.foods.find((food: any) => food.id === 90004).count, 3);
    assert.equal(result.maxProtectDuration, MAX_PROTECT_DURATION_SECONDS);
});

test('狗粮请求仅在保护时长实际增加时判定为已生效', () => {
    assert.equal(didProtectDurationIncrease(86400, 172800), true);
    assert.equal(didProtectDurationIncrease(86400, 86400), false);
    assert.equal(didProtectDurationIncrease(86400, 0), false);
});

export {};
