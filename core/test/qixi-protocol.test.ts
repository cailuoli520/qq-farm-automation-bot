import assert from 'node:assert/strict';
import {
    buildDewLandTargets,
    ensureDewApplied,
    hasAppliedQixiDew,
    normalizeGroup,
    qixiActivityIsActive,
} from '../src/services/qixi';

const test = require('node:test') as typeof import('node:test');
const { loadProto, types } = require('../src/utils/proto');

test.before(async () => loadProto());

test('鹊桥活动组查询与筑桥请求匹配真实抓包', () => {
    const groupFixture = Buffer.from('08889c8ec607', 'hex');
    const claimFixture = Buffer.from('08899c8ec6071019ea07020800', 'hex');
    const group = types.GetGroupRequest.decode(groupFixture);
    const claim = types.ClaimQixiBridgeRewardsRequest.decode(claimFixture);

    assert.equal(group.group_id.toString(), '2026081800');
    assert.equal(claim.activity_id.toString(), '2026081801');
    assert.equal(claim.operate_type.toString(), '25');
    assert.equal(claim.params.step.toString(), '0');
    assert.deepEqual(Buffer.from(types.GetGroupRequest.encode(group).finish()), groupFixture);
    assert.deepEqual(Buffer.from(types.ClaimQixiBridgeRewardsRequest.encode(claim).finish()), claimFixture);
});

test('鹊桥活动组保留子活动、筑桥进度与赠礼进度', () => {
    const encoded = types.GetGroupReply.encode(types.GetGroupReply.create({
        group: {
            activity: { activity_id: '2026081800', name: '鹊桥寄情' },
            children: [
                {
                    activity: { activity_id: '2026081801', type: 15, name: '鹊桥寄情', begin_time: 100, end_time: 200, field_23: 1 },
                    qixi_bridge: { current_stage: 1, stages: [{ stage: 1, cost: { item_id: 1024, count: 50 }, rewards: [{ item_id: 1025, count: 5 }], status: 1 }] },
                },
                {
                    activity: { activity_id: '2026081802', type: 16, name: '鹊桥赠礼', begin_time: 100, end_time: 200 },
                    qixi_gift: { total_send_count: 3, total_send_limit: 20, total_receive_limit: 20 },
                },
            ],
        },
    })).finish();
    const reply = types.GetGroupReply.decode(encoded);
    const dto = normalizeGroup(reply, new Map([['1024', '52'], ['1025', '5'], ['1026', '1'], ['301103', '7']]));

    assert.equal(reply.group.children.length, 2);
    assert.equal(dto.bridge.currentStage, 1);
    assert.equal(dto.bridge.stages[0].cost.id, '1024');
    assert.equal(dto.gift.sentCount, '3');
    assert.equal(dto.balances.dew, '7');
    assert.equal(dto.actions.bridge.enabled, false, '测试时间已超过构造的活动窗口');
});

test('活动变化推送使用 ActivityData 并保留父子层级', () => {
    const encoded = types.ActiviesChangeNotify.encode(types.ActiviesChangeNotify.create({
        activities: [{
            activity: { activity_id: '2026081800' },
            children: [{ activity: { activity_id: '2026081801' }, qixi_bridge: { current_stage: 2 } }],
        }],
    })).finish();
    const notify = types.ActiviesChangeNotify.decode(encoded);

    assert.equal(notify.activities[0].activity.activity_id.toString(), '2026081800');
    assert.equal(notify.activities[0].children[0].qixi_bridge.current_stage.toString(), '2');
});

test('灵露目标协议保留农场 GID、地块与土地奖励', () => {
    const request = types.UseRequest.decode(types.UseRequest.encode(types.UseRequest.create({
        item: { id: 301103, count: 1, uid: '9223372036854775806' },
        target: { host_gid: '1237486904', land_ids: [1, 5], use_config_id: 0 },
    })).finish());
    const reply = types.UseReply.decode(types.UseReply.encode(types.UseReply.create({
        used_items: [{ id: 301103, count: 1 }],
        items: [{ id: 1024, count: 1 }],
        land: {
            id: 5,
            unlocked: true,
            plant: {
                id: 20001,
                mutant_config_ids: [13],
                field_40: [{ value_1: 9, value_2: 1 }],
            },
        },
        land_reward: { land_id: 5, items: [{ id: 1024, count: 1 }] },
    })).finish());

    assert.equal(request.target.host_gid.toString(), '1237486904');
    assert.deepEqual(request.target.land_ids.map((id: any) => id.toString()), ['1', '5']);
    assert.equal(reply.land.id.toString(), '5');
    assert.equal(reply.land.plant.field_40[0].value_1.toString(), '9');
    assert.equal(reply.land.plant.field_40[0].value_2.toString(), '1');
    assert.equal(reply.land_reward.items[0].id.toString(), '1024');
});

test('灵露候选地块过滤已确认生效的七夕变异状态', () => {
    const appliedPlant = {
        id: 20001,
        phases: [{ phase: 4, begin_time: 1, mutants: [{ mutant_config_id: 13 }] }],
        field_40: [{ value_1: 10, value_2: 1 }],
    };
    const unrelatedHistory = {
        id: 20002,
        phases: [{ phase: 4, begin_time: 1 }],
        mutant_config_ids: [12],
        field_40: [{ value_1: 9, value_2: 1 }],
    };

    assert.equal(hasAppliedQixiDew(appliedPlant), true);
    assert.equal(hasAppliedQixiDew(unrelatedHistory), false, '没有七夕变异 13 时不能仅凭历史码过滤');

    const targets = buildDewLandTargets([
        { id: 1, unlocked: true, plant: appliedPlant },
        { id: 2, unlocked: true, plant: unrelatedHistory },
    ], { gid: '1237486904', name: '测试农场', isSelf: true });
    assert.deepEqual(targets.map(target => target.landId), ['2']);
});

test('灵露空回包不计为成功，只有明确消耗才确认生效', () => {
    assert.throws(
        () => ensureDewApplied({}),
        (error: Error & { code?: string }) => error.code === 'QIXI_DEW_NO_EFFECT',
    );
    assert.doesNotThrow(() => ensureDewApplied({ used_items: [{ id: 301103, count: 1 }] }));
});

test('活动启用同时受服务端存在性和时间窗口约束', () => {
    assert.throws(
        () => normalizeGroup({ group: { children: [] } }, null),
        (error: Error & { code?: string }) => error.code === 'QIXI_UNAVAILABLE',
    );
    assert.equal(qixiActivityIsActive({ begin_time: 100, end_time: 200 }, 150), true);
    assert.equal(qixiActivityIsActive({ begin_time: 100, end_time: 200 }, 201), false);
});

export {};
