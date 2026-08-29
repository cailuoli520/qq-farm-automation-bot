const assert = require('node:assert/strict');
const test = require('node:test');
const { sendPushooMessage } = require('../src/services/push');

test('推送提供方无响应时会在截止时间内返回超时', async () => {
    const never = new Promise(() => {});

    await assert.rejects(
        sendPushooMessage({
            channel: 'webhook',
            endpoint: 'https://example.invalid/push',
            title: '测试',
            content: '测试内容',
        }, {
            send: () => never,
            timeoutMs: 5,
        }),
        error => error?.code === 'OPERATION_TIMEOUT' && /推送请求超时/.test(error.message),
    );
});

export {};
