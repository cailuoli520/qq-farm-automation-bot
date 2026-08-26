const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { createWorkerPetGiftRuntime } = require('../src/runtime/worker-pet-gifts');

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('等待宠物礼包领取超时');
        await delay(5);
    }
}

function createHarness() {
    const events = new EventEmitter();
    const calls: unknown[] = [];
    const logs: unknown[] = [];
    let active = true;
    const runtime = createWorkerPetGiftRuntime({
        events,
        service: {
            async claimDogSkillGifts(hint: unknown) {
                calls.push(hint);
                return { claimed: 1 };
            },
        },
        isLifecycleActive: () => active,
        log: (...args: unknown[]) => logs.push(args),
        delayMs: 5,
    });
    return { events, calls, logs, runtime, deactivate: () => { active = false; } };
}

test('宠物礼包推送合并突发数量并只注册一个监听器', async (t) => {
    const harness = createHarness();
    t.after(() => harness.runtime.stop());
    harness.runtime.start();
    harness.runtime.start();
    assert.equal(harness.events.listenerCount('dogSkillGiftPending'), 1);

    harness.events.emit('dogSkillGiftPending', 1);
    harness.events.emit('dogSkillGiftPending', 3);
    harness.events.emit('dogSkillGiftPending', 2);
    await waitFor(() => harness.calls.length === 1);
    assert.deepEqual(harness.calls, [3]);
});

test('登录补查可主动领取，停止后取消等待任务', async () => {
    const harness = createHarness();
    harness.runtime.start();
    harness.runtime.checkNow();
    await waitFor(() => harness.calls.length === 1);
    assert.deepEqual(harness.calls, [undefined]);

    harness.events.emit('dogSkillGiftPending', 2);
    harness.deactivate();
    harness.runtime.stop();
    await delay(20);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.events.listenerCount('dogSkillGiftPending'), 0);
});

export {};
