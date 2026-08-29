const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFriendHelpOutcomeLog } = require('../src/services/friend-help-outcome');

test('批量帮助日志区分完成、跳过、护主犬和进入失败', () => {
    const entry = (status: string, acted = false, entered = true) => (
        buildFriendHelpOutcomeLog({ status, acted, entered }, 2, 5, '测试好友')
    );

    assert.deepEqual(entry('helped', true), {
        event: '批量帮助完成', message: '批量帮助第 2/5 个好友完成: 测试好友', result: 'ok',
    });
    assert.deepEqual(entry('protect_dog_bypass', true), {
        event: '批量帮助护主犬', message: '批量帮助第 2/5 个好友护主犬绕过经验上限后完成: 测试好友', result: 'ok',
    });
    assert.equal(entry('skipped_exp_limit').reason, 'exp_limit');
    assert.equal(entry('no_action').reason, 'no_action');
    assert.equal(entry('enter_failed', false, false).result, 'error');
});
