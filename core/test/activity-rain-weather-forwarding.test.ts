const assert = require('node:assert/strict');
const test = require('node:test');

test('活动门面完整透传好友天气缓存与强制刷新选项', async () => {
    const rainPoetryPath = require.resolve('../src/services/rain-poetry');
    const activityDomainPath = require.resolve('../src/services/activity-domain');
    const activityPath = require.resolve('../src/services/activity');
    const originalRainPoetryModule = require.cache[rainPoetryPath];
    const originalActivityDomainModule = require.cache[activityDomainPath];
    const originalActivityModule = require.cache[activityPath];
    const calls: unknown[][] = [];

    require.cache[rainPoetryPath] = {
        exports: {
            async getRainPoetryWeather(...args: unknown[]) {
                calls.push(args);
                return { ok: true };
            },
        },
    } as NodeJS.Module;
    delete require.cache[activityDomainPath];
    delete require.cache[activityPath];

    try {
        const activity = require('../src/services/activity');
        const options = { cacheOnly: true, forceRefresh: false };
        assert.deepEqual(await activity.getRainPoetryWeather('123', options), { ok: true });
        assert.deepEqual(calls, [['123', options]]);
    } finally {
        if (originalRainPoetryModule) require.cache[rainPoetryPath] = originalRainPoetryModule;
        else delete require.cache[rainPoetryPath];
        if (originalActivityDomainModule) require.cache[activityDomainPath] = originalActivityDomainModule;
        else delete require.cache[activityDomainPath];
        if (originalActivityModule) require.cache[activityPath] = originalActivityModule;
        else delete require.cache[activityPath];
    }
});
