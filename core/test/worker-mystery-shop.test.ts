const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createWorkerMysteryShopRuntime } = require('../src/runtime/worker-mystery-shop');

function createOffer(overrides = {}) {
    return {
        key: '1007:1786955583',
        npcId: '1007',
        expireTime: 1786955583,
        reward: { id: '21135', count: '8', name: '艾草种子', image: '' },
        currency: {
            id: '1001',
            name: '金币',
            unitPrice: '5000',
            totalPrice: '40000',
            originalUnitPrice: '10000',
            originalTotalPrice: '80000',
        },
        discountPercent: 50,
        ...overrides,
    };
}

function createHarness(overrides = {}) {
    const events = new EventEmitter();
    const logs = [];
    let active = true;
    let enabled = true;
    let connectionReady = true;
    let automation = {
        mystery_shop_buy: true,
        mystery_shop_allow_gold: true,
        mystery_shop_arrival_notify: false,
        mystery_shop_purchase_notify: false,
    };
    let buyCalls = 0;
    const offer = createOffer();
    const service = {
        async buyNpcGoods() {
            buyCalls += 1;
            return { rewards: [{ id: '21135', count: '8', name: '艾草种子' }] };
        },
        async getActiveNPC() {
            return offer;
        },
        mysteryRewards(value) {
            return value?.rewards || [];
        },
        normalizeMysteryShopOffer(value) {
            return value?.key ? value : null;
        },
        ...overrides,
    };
    const runtime = createWorkerMysteryShopRuntime({
        events,
        getAutomation: () => ({ ...automation, mystery_shop_buy: enabled }),
        getCurrencyBalance: () => '100000',
        isConnectionReady: () => connectionReady,
        isLifecycleActive: () => active,
        log: (tag, message, meta) => logs.push({ tag, message, meta }),
        now: () => 1786870000 * 1000,
        service,
    });
    return {
        events,
        logs,
        offer,
        runtime,
        buyCalls: () => buyCalls,
        setActive(value) { active = value; },
        setConnectionReady(value) { connectionReady = value; },
        setEnabled(value) { enabled = value; },
        setAutomation(value) { automation = { ...automation, ...value }; },
    };
}

test('神秘商人推送监听只注册一次，并合并同一商品的突发通知', async (t) => {
    let releaseBuy;
    const harness = createHarness({
        async buyNpcGoods() {
            await new Promise(resolve => { releaseBuy = resolve; });
            return { rewards: [{ id: '21135', count: '8', name: '艾草种子' }] };
        },
    });
    t.after(() => harness.runtime.stop());
    harness.runtime.start();
    harness.runtime.start();
    assert.equal(harness.events.listenerCount('mysteryShopNotify'), 1);

    const pending = harness.runtime.handleOffer(harness.offer);
    const duplicatePending = harness.runtime.handleOffer(harness.offer);
    releaseBuy();
    const [first, second] = await Promise.all([pending, duplicatePending]);

    assert.equal(first.outcome, 'purchased');
    assert.equal(second.outcome, 'purchased');
    assert.equal(harness.logs.length, 1);
    assert.equal(harness.logs[0].meta.event, 'auto_buy');

    assert.equal((await harness.runtime.handleOffer(harness.offer)).outcome, 'duplicate');
    assert.equal(harness.logs.length, 1);
});

test('断线暂停神秘商人监听，重登后恢复且不会重复注册', async (t) => {
    const harness = createHarness();
    t.after(() => harness.runtime.stop());
    harness.runtime.start();
    assert.equal(harness.events.listenerCount('mysteryShopNotify'), 1);

    harness.setConnectionReady(false);
    harness.runtime.pause();
    assert.equal(harness.events.listenerCount('mysteryShopNotify'), 0);
    assert.equal((await harness.runtime.checkNow()).outcome, 'stopped');
    assert.equal(harness.buyCalls(), 0);

    harness.setConnectionReady(true);
    harness.runtime.resume();
    harness.runtime.resume();
    assert.equal(harness.events.listenerCount('mysteryShopNotify'), 1);
    assert.equal((await harness.runtime.checkNow()).outcome, 'purchased');
    assert.equal(harness.buyCalls(), 1);
});

test('自动购买关闭时忽略推送，开启后立即查询并购买', async (t) => {
    const harness = createHarness();
    t.after(() => harness.runtime.stop());
    harness.runtime.start();
    harness.setEnabled(false);

    harness.events.emit('mysteryShopNotify', harness.offer);
    await delay(10);
    assert.equal(harness.buyCalls(), 0);
    assert.equal((await harness.runtime.checkNow()).outcome, 'disabled');

    harness.setEnabled(true);
    assert.equal((await harness.runtime.checkNow()).outcome, 'purchased');
    assert.equal(harness.buyCalls(), 1);
});

test('购买失败不写入去重状态，后续同轮推送可以重试', async (t) => {
    let calls = 0;
    const harness = createHarness({
        async buyNpcGoods() {
            calls += 1;
            if (calls === 1) throw new Error('临时网络错误');
            return { rewards: [{ id: '21135', count: '8', name: '艾草种子' }] };
        },
    });
    t.after(() => harness.runtime.stop());

    assert.equal((await harness.runtime.handleOffer(harness.offer)).outcome, 'failed');
    assert.equal((await harness.runtime.handleOffer(harness.offer)).outcome, 'purchased');
    assert.equal(calls, 2);
    assert.equal(harness.logs[0].meta.result, 'error');
    assert.equal(harness.logs[1].meta.result, 'ok');
});

test('过期商品和已停止 Worker 都不会下单', async (t) => {
    const harness = createHarness();
    t.after(() => harness.runtime.stop());

    assert.equal((await harness.runtime.handleOffer(createOffer({ expireTime: 1786869999 }))).outcome, 'expired');
    harness.setActive(false);
    assert.equal((await harness.runtime.handleOffer(harness.offer)).outcome, 'stopped');
    assert.equal(harness.buyCalls(), 0);
});

test('未允许币种、余额未知和余额不足时不会下单', async (t) => {
    const disallowed = createHarness();
    t.after(() => disallowed.runtime.stop());
    disallowed.setAutomation({ mystery_shop_allow_gold: false });
    assert.equal((await disallowed.runtime.handleOffer(disallowed.offer)).outcome, 'currency_not_allowed');

    const unknown = createHarness({});
    t.after(() => unknown.runtime.stop());
    const unknownRuntime = createWorkerMysteryShopRuntime({
        events: unknown.events,
        getAutomation: () => ({ mystery_shop_buy: true, mystery_shop_allow_gold: true }),
        getCurrencyBalance: () => null,
        isLifecycleActive: () => true,
        log: () => {},
        now: () => 1786870000 * 1000,
        service: {
            async buyNpcGoods() { throw new Error('不应购买'); },
            async getActiveNPC() { return unknown.offer; },
            mysteryRewards: value => value?.rewards || [],
            normalizeMysteryShopOffer: value => value?.key ? value : null,
        },
    });
    t.after(() => unknownRuntime.stop());
    assert.equal((await unknownRuntime.handleOffer(unknown.offer)).outcome, 'balance_unknown');

    const insufficient = createWorkerMysteryShopRuntime({
        events: unknown.events,
        getAutomation: () => ({ mystery_shop_buy: true, mystery_shop_allow_gold: true }),
        getCurrencyBalance: () => '39999',
        isLifecycleActive: () => true,
        log: () => {},
        now: () => 1786870000 * 1000,
        service: {
            async buyNpcGoods() { throw new Error('不应购买'); },
            async getActiveNPC() { return unknown.offer; },
            mysteryRewards: value => value?.rewards || [],
            normalizeMysteryShopOffer: value => value?.key ? value : null,
        },
    });
    t.after(() => insufficient.stop());
    assert.equal((await insufficient.handleOffer(unknown.offer)).outcome, 'insufficient');
});

test('余额不足时仍发送到货提醒', async (t) => {
    const notifications = [];
    const harness = createHarness();
    const runtime = createWorkerMysteryShopRuntime({
        events: harness.events,
        getAutomation: () => ({
            mystery_shop_buy: true,
            mystery_shop_allow_gold: true,
            mystery_shop_arrival_notify: true,
        }),
        getCurrencyBalance: () => '1',
        isLifecycleActive: () => true,
        log: () => {},
        notify: (title, content) => notifications.push({ title, content }),
        now: () => 1786870000 * 1000,
        service: {
            async buyNpcGoods() { throw new Error('余额不足时不应购买'); },
            async getActiveNPC() { return harness.offer; },
            mysteryRewards: value => value?.rewards || [],
            normalizeMysteryShopOffer: value => value?.key ? value : null,
        },
    });
    t.after(() => runtime.stop());

    assert.equal((await runtime.handleOffer(harness.offer)).outcome, 'insufficient');
    assert.equal((await runtime.handleOffer(harness.offer)).outcome, 'insufficient');
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /到货/);
});

test('提醒发送失败不改变已完成购买结果', async (t) => {
    const harness = createHarness();
    const runtime = createWorkerMysteryShopRuntime({
        events: harness.events,
        getAutomation: () => ({
            mystery_shop_buy: true,
            mystery_shop_allow_gold: true,
            mystery_shop_purchase_notify: true,
        }),
        getCurrencyBalance: () => '100000',
        isLifecycleActive: () => true,
        log: () => {},
        notify: async () => { throw new Error('推送渠道不可用'); },
        now: () => 1786870000 * 1000,
        service: {
            async buyNpcGoods() { return { rewards: [{ id: '21135', count: '8', name: '艾草种子' }] }; },
            async getActiveNPC() { return harness.offer; },
            mysteryRewards: value => value?.rewards || [],
            normalizeMysteryShopOffer: value => value?.key ? value : null,
        },
    });
    t.after(() => runtime.stop());

    assert.equal((await runtime.handleOffer(harness.offer)).outcome, 'purchased');
    assert.equal((await runtime.handleOffer(harness.offer)).outcome, 'duplicate');
});

test('到货和购买提醒按同一轮商品去重', async (t) => {
    const notifications = [];
    const harness = createHarness();
    harness.setAutomation({
        mystery_shop_arrival_notify: true,
        mystery_shop_purchase_notify: true,
    });
    const runtime = createWorkerMysteryShopRuntime({
        events: harness.events,
        getAutomation: () => ({
            mystery_shop_buy: true,
            mystery_shop_allow_gold: true,
            mystery_shop_arrival_notify: true,
            mystery_shop_purchase_notify: true,
        }),
        getCurrencyBalance: () => '100000',
        isLifecycleActive: () => true,
        log: () => {},
        notify: (title, content) => notifications.push({ title, content }),
        now: () => 1786870000 * 1000,
        service: {
            async buyNpcGoods() { return { rewards: [{ id: '21135', count: '8', name: '艾草种子' }] }; },
            async getActiveNPC() { return harness.offer; },
            mysteryRewards: value => value?.rewards || [],
            normalizeMysteryShopOffer: value => value?.key ? value : null,
        },
    });
    t.after(() => runtime.stop());
    assert.equal((await runtime.handleOffer(harness.offer)).outcome, 'purchased');
    assert.equal((await runtime.handleOffer(harness.offer)).outcome, 'duplicate');
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].title, /自动购买/);
});

export {};
