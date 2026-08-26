import assert from 'node:assert/strict';
import { ensureRainCollectionResult, normalizeGroup, normalizeWeather, rainActivityIsActive, requireUnlockableResearchNode, withFriendFarm } from '../src/services/rain-poetry';

const test = require('node:test') as typeof import('node:test');
const { loadProto, types } = require('../src/utils/proto');

test.before(async () => loadProto());

test('雨落成诗三个写请求匹配真实抓包并可往返编码', () => {
    const exchangeFixture = Buffer.from('089dc28dc6071001aa060508c8011001', 'hex');
    const collectFixture = Buffer.from('089fc28dc6071009da060618d6a7add204', 'hex');
    const researchFixture = Buffer.from('08a0c28dc6071028e2080308e807', 'hex');

    const exchange = types.ExchangeShopRequest.decode(exchangeFixture);
    const collect = types.CollectRainWeatherRequest.decode(collectFixture);
    const research = types.UnlockRainResearchRequest.decode(researchFixture);

    assert.equal(exchange.activity_id.toString(), '2026070301');
    assert.equal(exchange.exchange_shop_operate.goods_id.toString(), '200');
    assert.equal(collect.activity_id.toString(), '2026070303');
    assert.equal(collect.params.target_gid.toString(), '1246450646');
    assert.equal(research.activity_id.toString(), '2026070304');
    assert.equal(research.params.node_id.toString(), '1000');
    assert.deepEqual(Buffer.from(types.ExchangeShopRequest.encode(exchange).finish()), exchangeFixture);
    assert.deepEqual(Buffer.from(types.CollectRainWeatherRequest.encode(collect).finish()), collectFixture);
    assert.deepEqual(Buffer.from(types.UnlockRainResearchRequest.encode(research).finish()), researchFixture);
});

test('天气状态匹配抓包中的两小时雷雨窗口', () => {
    const fixture = Buffer.from('0a1208011002188198bad40620a1d0bad4062801', 'hex');
    const reply = types.GetWeatherStatusReply.decode(fixture);
    const weather = normalizeWeather(reply);

    assert.equal(weather.weatherId, '1');
    assert.equal(weather.type, '2');
    assert.equal(weather.startTime, '1787726849');
    assert.equal(weather.endTime, '1787734049');
    assert.equal(weather.thunderstorm, true);
    assert.deepEqual(Buffer.from(types.GetWeatherStatusReply.encode(reply).finish()), fixture);
});

test('普通雨天使用友好名称且不会误判为可采集雷雨', () => {
    const weather = normalizeWeather({
        weather_id: 1,
        weather_type: 1,
        begin_time: 1787731251,
        end_time: 1787738451,
        active: true,
    });

    assert.equal(weather.name, '普通雨天');
    assert.equal(weather.active, true);
    assert.equal(weather.thunderstorm, false);
});

test('好友进入回包解析真实天气而不依赖自己的天气查询', () => {
    const fixture = Buffer.from('6a140801100218c2feb9d40620e2b6bad40628014001', 'hex');
    const reply = types.VisitEnterReply.decode(fixture);
    const weather = normalizeWeather(reply.weather_status);

    assert.equal(reply.weather_status.weather_id.toString(), '1');
    assert.equal(reply.weather_status.weather_type.toString(), '2');
    assert.equal(reply.weather_status.field_8, true);
    assert.equal(weather.thunderstorm, true);
    assert.deepEqual(Buffer.from(types.VisitEnterReply.encode(reply).finish()), fixture);
});

test('采集回包明确包含召唤瓶奖励和采集瓶消耗', () => {
    const fixture = Buffer.from(
        '089fc28dc6071009e2061a0a0a08f9551205088a2710011205088a2710011a050889271001',
        'hex',
    );
    const reply = types.ActivityOperateReply.decode(fixture);

    assert.equal(reply.activity_id.toString(), '2026070303');
    assert.equal(reply.operate_type.toString(), '9');
    assert.equal(reply.weather_collection_result.received_item.item_id.toString(), '5002');
    assert.equal(reply.weather_collection_result.consumed_item.item_id.toString(), '5001');
    assert.deepEqual(Buffer.from(types.ActivityOperateReply.encode(reply).finish()), fixture);
});

test('ActivityData 114 保留原始负载供活动类型分派解码', () => {
    const quotePayload = types.QingMeiQuote.encode(types.QingMeiQuote.create({ round: 2, unit_price: 300, total_gold: 600, doubled: true })).finish();
    const data = types.GetGroupReply.decode(types.GetGroupReply.encode(types.GetGroupReply.create({
        group: { activity: { activity_id: '2026081202' }, extension_114: quotePayload },
    })).finish()).group;
    const quote = types.QingMeiQuote.decode(data.extension_114);

    assert.equal(quote.round.toString(), '2');
    assert.equal(quote.total_gold.toString(), '600');
    assert.equal(quote.doubled, true);
});

test('活动组聚合余额、任务、研究依赖和操作状态', () => {
    const groupReply = types.GetGroupReply.decode(types.GetGroupReply.encode(types.GetGroupReply.create({
        group: {
            activity: { activity_id: '2026070300', name: '雨落成诗', begin_time: 100, end_time: '9999999999' },
            children: [
                { activity: { activity_id: '2026070301', extra: Buffer.from('{"tips":{"title":"活动说明","txt":["规则"]}}') }, catalog: { goods: [{ goods_id: 200, item: { item_id: 5001, count: 1 }, cost: { item_id: 1005, count: 200 } }] } },
                { activity: { activity_id: '2026070303' }, weather_collection: { consume_item_id: 5001, consume_count: 1, enabled: true } },
                { activity: { activity_id: '2026070304' }, weather_research: { groups: [{ group_id: 1, nodes: [
                    { node_id: 1000, status: 2, enabled: true, cost: { item_id: 1027, count: 20 }, reward: { item_id: 5001, count: 1 } },
                    { node_id: 1001, prerequisite_ids: [9999], status: 2, enabled: true, cost: { item_id: 1027, count: 20 }, reward: { item_id: 5002, count: 1 } },
                    { node_id: 1006, status: 1, enabled: true, cost: { item_id: 1027, count: 80 }, reward: { item_id: 4002, count: 1 } },
                    { node_id: 1007, status: 1, enabled: true, cost: { item_id: 1027, count: 80 }, reward: { item_id: 4003, count: 1 } },
                    { node_id: 1008, status: 1, enabled: true, cost: { item_id: 1027, count: 100 }, reward: { item_id: 2159, count: 1 } },
                ] }] } },
                { activity: { activity_id: '2026070305' }, weather_tasks: { tasks: [{ task_id: 1, item_id: 5001, reward: { item_id: 1027, count: 10 }, name: '使用天气采集瓶', target: 10, progress: 3 }] } },
            ],
        },
    })).finish());
    const bagReply = { item_bag: { items: [{ id: 1005, count: 500 }, { id: 1027, count: 30 }, { id: 5001, count: 1 }, { id: 5002, count: 1 }] } };
    const weatherReply = types.GetWeatherStatusReply.create({ status: {} });
    const dto = normalizeGroup(groupReply, bagReply, weatherReply);

    assert.equal(dto.active, true);
    assert.equal(dto.balances.badge, '30');
    assert.equal(dto.exchangeItems[0].available, true);
    assert.equal(dto.tasks[0].progress, '3');
    assert.equal(dto.researchNodes[0].unlockable, true);
    assert.equal(dto.researchNodes[1].unlockable, false);
    assert.deepEqual(dto.researchNodes.slice(2).map((node: { reward: { name: string } }) => node.reward.name), [
        '闪电变异瓶',
        '霹雳引雷瓶',
        '雨落成诗纪念奖励',
    ]);
    assert.equal(dto.actions.collect.enabled, true);
    assert.equal(dto.actions.thunderstorm.enabled, true);

    const degraded = normalizeGroup(groupReply, null, null);
    assert.equal(degraded.active, true);
    assert.equal(degraded.balances.known, false);
    assert.equal(degraded.weather.known, false);
    assert.equal(degraded.actions.exchange.availabilityKnown, false);
    assert.equal(degraded.actions.collect.enabled, false);
    assert.equal(degraded.actions.thunderstorm.enabled, false);
    assert.equal(degraded.actions.research.enabled, false);
});

test('活动有效性包含开始和结束边界', () => {
    assert.equal(rainActivityIsActive({ begin_time: 100, end_time: 200 }, 99), false);
    assert.equal(rainActivityIsActive({ begin_time: 100, end_time: 200 }, 100), true);
    assert.equal(rainActivityIsActive({ begin_time: 100, end_time: 200 }, 200), true);
    assert.equal(rainActivityIsActive({ begin_time: 100, end_time: 200 }, 201), false);
});

test('好友农场中的操作异常时仍然离开好友农场', async () => {
    const calls: string[] = [];
    await assert.rejects(
        () => withFriendFarm(
            '123',
            async () => { calls.push('operate'); throw new Error('weather failed'); },
            async (gid) => { calls.push(`enter:${gid}`); return {}; },
            async (gid) => { calls.push(`leave:${gid}`); },
        ),
        /weather failed/,
    );
    assert.deepEqual(calls, ['enter:123', 'operate', 'leave:123']);
});

test('空采集回包不计成功，研究节点拒绝重复或未开放解锁', () => {
    assert.throws(
        () => ensureRainCollectionResult({}),
        (error: Error & { code?: string }) => error.code === 'RAIN_RESPONSE_INVALID',
    );
    assert.throws(
        () => requireUnlockableResearchNode({ researchNodes: [{ id: '1000', claimed: true, unlockable: false }] }, '1000'),
        (error: Error & { code?: string }) => error.code === 'RAIN_RESEARCH_UNAVAILABLE',
    );
    assert.doesNotThrow(() => requireUnlockableResearchNode({ researchNodes: [{ id: '1001', claimed: false, unlockable: true }] }, '1001'));
});

export {};
