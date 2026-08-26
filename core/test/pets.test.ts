const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const protobuf = require('protobufjs');
const {
    buildPetSnapshot,
    didPendingGiftCountDecrease,
    didProtectDurationIncrease,
    getClaimedGiftCount,
    MAX_PROTECT_DURATION_SECONDS,
} = require('../src/services/pets');

test('宠物快照以 owned 字段判断获得状态，并仅统计未锁定狗粮', () => {
    const result = buildPetSnapshot({
        current_dog_id: 90001,
        protect_time: 86400,
        dogs: [
            { id: 90001, name: '小狗', owned: 1 },
            { id: 90002, name: '大狗', status: 1 },
        ],
        skill_usages: [
            { dog_id: 90021, skill_id: 2001, used_count: 7, daily_limit: 30 },
        ],
        pending_gift_count: 3,
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
    assert.equal(result.pendingGiftCount, 3);
    assert.equal(result.dogs.find((dog: any) => dog.id === 90021).skills[1].remainingCount, 23);
});

test('礼包领取复查只在待领取数量实际减少时确认生效', () => {
    assert.equal(didPendingGiftCountDecrease(3, 2), true);
    assert.equal(didPendingGiftCountDecrease(3, 3), false);
    assert.equal(didPendingGiftCountDecrease(0, 0), false);
});

test('礼包领取数量兼容 claimed_count 与 item.count 回包', () => {
    assert.equal(getClaimedGiftCount({ claimed_count: 2, item: { count: 5 } }), 2);
    assert.equal(getClaimedGiftCount({ item: { count: 3 } }), 3);
    assert.equal(getClaimedGiftCount({ claimed_count: 0, item: { count: 4 } }), 4);
    assert.equal(getClaimedGiftCount({}), 0);
});

test('宠物礼包与守护记录协议保持抓包字段编号', async () => {
    const root = new protobuf.Root();
    await root.load([
        path.join(process.cwd(), 'src/proto/corepb.proto'),
        path.join(process.cwd(), 'src/proto/dogpb.proto'),
    ], { keepCase: true });
    const claimReply = root.lookupType('gamepb.dogpb.ClaimSkillGiftsReply');
    const protectRequest = root.lookupType('gamepb.dogpb.GetProtectLogsRequest');
    assert.equal(claimReply.fields.item.id, 1);
    assert.equal(claimReply.fields.claimed_count.id, 3);
    assert.equal(protectRequest.fields.field_1.id, 1);
    assert.equal(protectRequest.fields.count.id, 2);
    assert.equal(protectRequest.fields.field_3.id, 3);
    const decoded = protectRequest.decode(
        protectRequest.encode({ field_1: 0, count: 100, field_3: 0 }).finish(),
    );
    assert.equal(decoded.count.toString(), '100');
});

test('狗粮请求仅在保护时长实际增加时判定为已生效', () => {
    assert.equal(didProtectDurationIncrease(86400, 172800), true);
    assert.equal(didProtectDurationIncrease(86400, 86400), false);
    assert.equal(didProtectDurationIncrease(86400, 0), false);
});

export {};
