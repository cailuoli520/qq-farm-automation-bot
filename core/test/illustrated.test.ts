const assert = require('node:assert/strict');
const test = require('node:test');
const { getIllustratedSnapshot, normalizeBook } = require('../src/services/illustrated');

test('图鉴快照规范化等级、收藏状态和奖励信息', () => {
    const result = normalizeBook(2, {
        level: 3,
        progress: 80,
        next_level_progress: 120,
        items: [{ seed_id: 20001, unlocked: true, progress: 40, reward_category: 2 }],
        current_bonus: { item_id: 1001, count: 50 },
    }, {
        level: 2,
        progress: 70,
        levels: [{ level: 4, progress: 120, claimed: false, rewards: [{ item_id: 1001, count: 100 }] }],
    });

    assert.equal(result.level, 3);
    assert.equal(result.progress, 80);
    assert.equal(result.nextLevelProgress, 120);
    assert.equal(result.items[0].seedId, 20001);
    assert.equal(result.items[0].unlocked, true);
    assert.deepEqual(result.currentBonus && { itemId: result.currentBonus.itemId, count: result.currentBonus.count }, { itemId: 1001, count: 50 });
});

test('图鉴分区串行读取，避免占满业务请求槽', async () => {
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const loader = kind => async (type) => {
        calls.push(`${kind}:${type}`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return kind === 'list' ? { items: [], type } : { levels: [], type };
    };

    await getIllustratedSnapshot(loader('list'), loader('levels'));

    assert.deepEqual(calls, ['list:1', 'levels:1', 'list:2', 'levels:2']);
    assert.equal(maxActive, 1);
});

export {};
