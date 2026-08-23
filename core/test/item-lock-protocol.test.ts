const assert = require('node:assert/strict');
const test = require('node:test');
const { loadProto, types } = require('../src/utils/proto');
const { isLockableItem } = require('../src/services/warehouse');

test.before(async () => loadProto());

test('锁定协议按 packed int64 原样保留大 UID', () => {
    const uid = '9223372036854775806';
    const encoded = types.LockItemsRequest.encode(types.LockItemsRequest.create({
        item_uids: [uid],
    })).finish();
    const decoded = types.LockItemsRequest.decode(encoded);
    assert.equal(decoded.item_uids[0].toString(), uid);

    const unlock = types.UnlockItemsRequest.decode(types.UnlockItemsRequest.encode(
        types.UnlockItemsRequest.create({ item_uids: [uid] }),
    ).finish());
    assert.equal(unlock.item_uids[0].toString(), uid);
});

test('背包 Item 的 locked 字段使用协议字段 9', () => {
    assert.equal(types.Item.fields.locked.id, 9);
    assert.equal(types.Item.fields.locked.type, 'bool');
});

test('尚未进入旧 ItemInfo 的活动种子和果实仍可锁定', () => {
    assert.equal(isLockableItem({ id: 29999 }), true);
    assert.equal(isLockableItem({ id: 49999 }), true);
    assert.equal(isLockableItem({ id: 99999 }), false);
});

export {};
