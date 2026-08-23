/** 鹊桥寄情活动：服务端发现、筑桥、赠礼与鹊羽灵露交互。 */

import type protobuf from 'protobufjs';
import { getPlantById, getPlantName, getSeedImageBySeedId } from '../config/gameConfig';
import { getUserState, sendMsgAsync } from '../utils/network';
import { types } from '../utils/proto';
import { getServerTimeSec, toLong, toNum } from '../utils/utils';
import { bytesToText, int64Number, int64String, itemDto } from './activity-dto';
import { asRecord, recordArray } from './service-boundaries';

const { PlantPhase, PHASE_NAMES } = require('../config/config');
const { getAllLands, buildLandMap, getCurrentPhase, getDisplayLandContext } = require('./farm');
const { enterFriendFarm, leaveFriendFarm } = require('./friend');
const { getBag, getBagItems } = require('./warehouse');

type DynamicRecord = Record<string, any>;
type TimeoutOrOptions = number | {
    timeoutMs?: number;
    expectedErrorCodes?: readonly number[];
    category?: 'business' | 'control';
};

const GROUP_ID = '2026081800';
const BRIDGE_ACTIVITY_ID = '2026081801';
const GIFT_ACTIVITY_ID = '2026081802';
const OPERATE_BRIDGE = 25;
const OPERATE_GIFT = 26;
const FEATHER_ITEM_ID = '1024';
const SACHET_ITEM_ID = '1025';
const RECEIVED_SACHET_ITEM_ID = '1026';
const DEW_ITEM_ID = 301103;
const DEFAULT_GIFT_MESSAGE_TEXT_ID = 15;
const MAX_SIGNED_INT64 = 9223372036854775807n;
const QIXI_MUTANT_CONFIG_ID = 13;
const QIXI_DEW_HISTORY_CODES = new Set([9, 10]);

class QixiBusinessError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'QixiBusinessError';
        this.code = code;
    }
}

function businessError(code: string, message: string): QixiBusinessError {
    return new QixiBusinessError(code, message);
}

function positiveInt64(value: unknown, code: string, fieldName: string): string {
    const text = typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : String(value ?? '').trim();
    if (!/^[1-9]\d*$/.test(text) || text.length > 19 || BigInt(text) > MAX_SIGNED_INT64) {
        throw businessError(code, `${fieldName} 必须是 int64 范围内的正整数`);
    }
    return text;
}

function parseRules(extra: unknown): { title: string; paragraphs: string[] } {
    const text = bytesToText(extra).trim();
    if (!text) return { title: '', paragraphs: [] };
    try {
        const parsed = JSON.parse(text);
        const tips = parsed && typeof parsed === 'object' ? parsed.tips : null;
        const paragraphs = Array.isArray(tips?.txt)
            ? tips.txt.map((entry: unknown) => String(entry || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()).filter(Boolean)
            : [];
        return { title: String(tips?.title || '').replace(/<[^>]+>/g, '').trim(), paragraphs };
    } catch {
        return { title: '', paragraphs: [text] };
    }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return Boolean(value && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function');
}

async function queryGroup(timeoutOrOptions: TimeoutOrOptions = 20000): Promise<DynamicRecord> {
    const body = Buffer.from(types.GetGroupRequest.encode(types.GetGroupRequest.create({
        group_id: toLong(GROUP_ID),
    })).finish());
    const { body: replyBody } = await sendMsgAsync(
        'gamepb.activitypb.ActivityService',
        'GetGroup',
        body,
        timeoutOrOptions,
    );
    return types.GetGroupReply.decode(replyBody);
}

function findChild(groupReply: unknown, activityId: string): DynamicRecord | null {
    const group = asRecord(asRecord(groupReply).group);
    return recordArray(group.children)
        .find(child => int64String(asRecord(child.activity).activity_id) === activityId) || null;
}

function qixiActivityIsActive(activityInput: unknown, serverTime = getServerTimeSec()): boolean {
    const activity = asRecord(activityInput);
    const beginTime = int64Number(activity.begin_time);
    const endTime = int64Number(activity.end_time);
    return (beginTime <= 0 || serverTime >= beginTime) && (endTime <= 0 || serverTime <= endTime);
}

function readBalances(bagReply: unknown): Map<string, string> {
    const wanted = new Set([FEATHER_ITEM_ID, SACHET_ITEM_ID, RECEIVED_SACHET_ITEM_ID, String(DEW_ITEM_ID)]);
    const balances = new Map<string, bigint>([...wanted].map(id => [id, 0n]));
    for (const item of getBagItems(bagReply)) {
        const source = asRecord(item);
        const id = int64String(source.id ?? source.item_id);
        if (!wanted.has(id)) continue;
        const count = BigInt(int64String(source.count));
        if (count > 0n) balances.set(id, (balances.get(id) || 0n) + count);
    }
    return new Map([...balances].map(([id, count]) => [id, count.toString()]));
}

function normalizeGroup(groupReply: unknown, balances: Map<string, string> | null): DynamicRecord {
    const bridgeChild = findChild(groupReply, BRIDGE_ACTIVITY_ID);
    const giftChild = findChild(groupReply, GIFT_ACTIVITY_ID);
    const bridgeActivity = asRecord(bridgeChild?.activity);
    const giftActivity = asRecord(giftChild?.activity);
    if (!bridgeChild || !giftChild || Object.keys(bridgeActivity).length === 0 || Object.keys(giftActivity).length === 0) {
        throw businessError('QIXI_UNAVAILABLE', '服务端未发现鹊桥寄情活动');
    }

    const bridge = asRecord(bridgeChild.qixi_bridge);
    const gift = asRecord(giftChild.qixi_gift);
    const currentStage = int64Number(bridge.current_stage);
    const bridgeClaimable = int64String(bridgeActivity.field_23) !== '0';
    const active = qixiActivityIsActive(bridgeActivity);
    const readBalance = (id: string): string | null => balances ? balances.get(id) || '0' : null;
    const feather = readBalance(FEATHER_ITEM_ID);
    const sachet = readBalance(SACHET_ITEM_ID);
    const receivedSachet = readBalance(RECEIVED_SACHET_ITEM_ID);
    const dew = readBalance(String(DEW_ITEM_ID));
    const sentCount = BigInt(int64String(gift.total_send_count));
    const sendLimit = BigInt(int64String(gift.total_send_limit));
    const giftWithinLimit = sendLimit <= 0n || sentCount < sendLimit;

    const stages = recordArray(bridge.stages).map((stage) => {
        const number = int64Number(stage.stage);
        const statusCode = int64String(stage.status);
        const completed = statusCode === '2' || (currentStage > 0 && number > 0 && number <= currentStage);
        const claimable = bridgeClaimable && number === currentStage;
        return {
            id: String(number),
            stage: number,
            statusCode,
            completed,
            claimed: completed && !claimable,
            claimable,
            current: number === currentStage,
            cost: itemDto(stage.cost),
            rewards: recordArray(stage.rewards).map(itemDto),
        };
    });

    return {
        groupId: GROUP_ID,
        activityId: BRIDGE_ACTIVITY_ID,
        bridgeActivityId: BRIDGE_ACTIVITY_ID,
        giftActivityId: GIFT_ACTIVITY_ID,
        name: bytesToText(bridgeActivity.name) || '鹊桥寄情',
        startTime: int64String(bridgeActivity.begin_time),
        endTime: int64String(bridgeActivity.end_time),
        serverTime: String(getServerTimeSec()),
        active,
        rules: parseRules(bridgeActivity.extra),
        feather: itemDto({ item_id: FEATHER_ITEM_ID, count: feather || '0' }),
        sachet: itemDto({ item_id: SACHET_ITEM_ID, count: sachet || '0' }),
        receivedSachet: itemDto({ item_id: RECEIVED_SACHET_ITEM_ID, count: receivedSachet || '0' }),
        dew: {
            ...itemDto({ item_id: DEW_ITEM_ID, count: dew || '0' }),
            balance: dew,
            balanceKnown: balances !== null,
            usable: active && (dew === null || BigInt(dew) > 0n),
        },
        balances: { feather, sachet, receivedSachet, dew, known: balances !== null },
        bridge: {
            currentStage,
            claimable: bridgeClaimable,
            stages,
            displayItems: recordArray(bridge.display_items).map(itemDto),
        },
        gift: {
            sentCount: sentCount.toString(),
            sendLimit: int64String(gift.total_send_limit),
            receiveLimit: int64String(gift.total_receive_limit),
            messageTextId: String(DEFAULT_GIFT_MESSAGE_TEXT_ID),
            exchanges: recordArray(gift.gifts).map(entry => ({
                costItems: recordArray(entry.cost_items).map(itemDto),
                receiveItems: recordArray(entry.receive_items).map(itemDto),
                giftType: int64String(entry.gift_type),
                content: int64String(entry.content),
            })),
        },
        actions: {
            bridge: { enabled: active && bridgeClaimable, available: active && bridgeClaimable, availabilityKnown: true },
            gift: { enabled: active && giftWithinLimit && (sachet === null || BigInt(sachet) > 0n), available: active && giftWithinLimit && (sachet === null || BigInt(sachet) > 0n), availabilityKnown: balances !== null },
            dew: { enabled: active && (dew === null || BigInt(dew) > 0n), available: active && (dew === null || BigInt(dew) > 0n), availabilityKnown: balances !== null },
        },
    };
}

async function getCurrentQixiActivity(
    bagInput: unknown = null,
    timeoutOrOptions: TimeoutOrOptions = 20000,
): Promise<DynamicRecord> {
    const deferredBag = isPromiseLike(bagInput)
        ? Promise.resolve(bagInput).then(
            value => ({ ok: true as const, value }),
            error => ({ ok: false as const, error }),
        )
        : null;
    const groupReply = await queryGroup(timeoutOrOptions);
    let balances: Map<string, string> | null = null;
    try {
        const settledBag = deferredBag ? await deferredBag : null;
        if (settledBag && 'error' in settledBag) {
            throw settledBag.error;
        }
        const bagReply = settledBag && 'value' in settledBag
            ? settledBag.value
            : bagInput || await getBag(timeoutOrOptions);
        balances = readBalances(bagReply);
    } catch { /* 背包失败只影响余额可用性，不影响活动发现。 */ }
    return normalizeGroup(groupReply, balances);
}

async function requireActiveActivity(): Promise<void> {
    const groupReply = await queryGroup();
    const activity = asRecord(findChild(groupReply, BRIDGE_ACTIVITY_ID)?.activity);
    if (Object.keys(activity).length === 0) throw businessError('QIXI_UNAVAILABLE', '服务端未发现鹊桥寄情活动');
    if (!qixiActivityIsActive(activity)) throw businessError('QIXI_DEW_UNAVAILABLE', '鹊桥寄情活动未进行，灵露当前不可使用');
}

async function operate(requestType: protobuf.Type, payload: DynamicRecord): Promise<DynamicRecord> {
    const body = Buffer.from(requestType.encode(requestType.create(payload)).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    return types.ActivityOperateReply.decode(replyBody);
}

async function claimBridgeRewards(): Promise<DynamicRecord> {
    const activity = await getCurrentQixiActivity();
    if (!activity.actions.bridge.enabled) throw businessError('QIXI_BRIDGE_UNAVAILABLE', '当前没有可领取的鹊桥奖励');
    const reply = await operate(types.ClaimQixiBridgeRewardsRequest, {
        activity_id: toLong(BRIDGE_ACTIVITY_ID), operate_type: OPERATE_BRIDGE, params: { step: 0 },
    });
    if (int64String(reply.activity_id) !== BRIDGE_ACTIVITY_ID || int64String(reply.operate_type) !== String(OPERATE_BRIDGE)) {
        throw businessError('QIXI_RESPONSE_INVALID', '鹊桥奖励回包与请求不匹配');
    }
    const result = asRecord(reply.qixi_bridge_result);
    const claimedStages = (Array.isArray(result.unlocked_steps) ? result.unlocked_steps : []).map(int64String);
    const rewards = recordArray(result.awards).length > 0 ? recordArray(result.awards) : recordArray(reply.rewards);
    return {
        claimedStages,
        rewards: rewards.map(itemDto),
        completed: !!result.completed,
        message: claimedStages.length > 0 ? `已完成第 ${claimedStages.join('、')} 阶段鹊桥并领取奖励` : '鹊桥奖励领取成功',
    };
}

async function giftSachet(friendGidInput: unknown, messageTextIdInput: unknown = DEFAULT_GIFT_MESSAGE_TEXT_ID): Promise<DynamicRecord> {
    const friendGid = positiveInt64(friendGidInput, 'INVALID_QIXI_FRIEND_GID', 'friendGid');
    const messageTextId = positiveInt64(messageTextIdInput ?? DEFAULT_GIFT_MESSAGE_TEXT_ID, 'INVALID_QIXI_MESSAGE_TEXT_ID', 'messageTextId');
    const activity = await getCurrentQixiActivity();
    if (!activity.actions.gift.enabled) throw businessError('QIXI_GIFT_UNAVAILABLE', '当前无法赠送鹊羽香囊');
    const reply = await operate(types.GiftQixiSachetRequest, {
        activity_id: toLong(GIFT_ACTIVITY_ID),
        operate_type: OPERATE_GIFT,
        params: { target_gid: toLong(friendGid), msg_text_id: toLong(messageTextId) },
    });
    if (int64String(reply.activity_id) !== GIFT_ACTIVITY_ID || int64String(reply.operate_type) !== String(OPERATE_GIFT)) {
        throw businessError('QIXI_RESPONSE_INVALID', '鹊羽香囊回包与请求不匹配');
    }
    return {
        friendGid,
        messageTextId,
        totalSendCount: int64String(asRecord(reply.qixi_gift_result).total_send_count),
        message: `已向好友 ${friendGid} 赠送 1 个鹊羽香囊`,
    };
}

function currentHost(hostGidInput: unknown): DynamicRecord {
    const state = asRecord(getUserState());
    const selfGid = positiveInt64(state.gid, 'QIXI_DEW_ACCOUNT_UNAVAILABLE', '当前账号 GID');
    const rawHostGid = String(hostGidInput ?? '').trim();
    const gid = !rawHostGid || rawHostGid === '0'
        ? selfGid
        : positiveInt64(rawHostGid, 'INVALID_QIXI_DEW_HOST_GID', 'hostGid');
    return {
        gid,
        name: gid === selfGid ? String(state.remark || state.name || '我的农场') : `GID:${gid}`,
        avatarUrl: gid === selfGid ? String(state.avatar_url || '') : '',
        isSelf: gid === selfGid,
    };
}

function hasQixiMutant(plant: DynamicRecord): boolean {
    const configIds = [
        ...(Array.isArray(plant.mutant_config_ids) ? plant.mutant_config_ids : []),
        ...recordArray(plant.phases).flatMap(phase => recordArray(phase.mutants).map(mutant => mutant.mutant_config_id)),
    ];
    return configIds.some(id => toNum(id) === QIXI_MUTANT_CONFIG_ID);
}

function hasAppliedQixiDew(plantInput: unknown): boolean {
    const plant = asRecord(plantInput);
    if (!hasQixiMutant(plant)) return false;
    const statuses = Array.isArray(plant.field_40)
        ? recordArray(plant.field_40)
        : Object.keys(asRecord(plant.field_40)).length > 0 ? [asRecord(plant.field_40)] : [];
    return statuses.some(status => (
        QIXI_DEW_HISTORY_CODES.has(toNum(status.value_1))
        && toNum(status.value_2) === 1
    ));
}

function buildDewLandTargets(landsInput: unknown, host: DynamicRecord): DynamicRecord[] {
    const lands = recordArray(landsInput);
    const landsMap = buildLandMap(lands);
    const seen = new Set<number>();
    const targets: DynamicRecord[] = [];
    for (const land of lands) {
        if (!land.unlocked) continue;
        const context = getDisplayLandContext(land, landsMap);
        if (context.occupiedByMaster) continue;
        const sourceLand = context.sourceLand || land;
        const landId = toNum(sourceLand.id);
        if (landId <= 0 || seen.has(landId)) continue;
        const plant = sourceLand.plant;
        if (!plant?.phases?.length) continue;
        if (hasAppliedQixiDew(plant)) continue;
        const phase = getCurrentPhase(plant.phases);
        const phaseCode = toNum(phase?.phase);
        if (phaseCode < PlantPhase.SEED || phaseCode > PlantPhase.MATURE || phaseCode === PlantPhase.DEAD) continue;
        const plantId = toNum(plant.id);
        const seedId = toNum(getPlantById(plantId)?.seed_id);
        seen.add(landId);
        targets.push({
            id: String(landId),
            landId: String(landId),
            hostGid: String(host.gid),
            ownerName: String(host.name),
            isSelf: !!host.isSelf,
            plantId: String(plantId),
            plantName: getPlantName(plantId) || String(plant.name || '未知作物'),
            seedId: String(seedId || 0),
            seedImage: seedId > 0 ? getSeedImageBySeedId(seedId) : '',
            phaseCode,
            phaseName: PHASE_NAMES[phaseCode] || `阶段${phaseCode}`,
            mature: phaseCode === PlantPhase.MATURE,
            occupiedLandIds: (Array.isArray(context.occupiedLandIds) ? context.occupiedLandIds : [landId]).map(String),
        });
    }
    return targets.sort((left, right) => Number(left.landId) - Number(right.landId));
}

function friendHost(reply: unknown, requestedGid: string): DynamicRecord {
    const basic = asRecord(asRecord(reply).basic);
    const actualGid = int64String(basic.gid);
    if (actualGid !== '0' && actualGid !== requestedGid) throw businessError('QIXI_DEW_HOST_MISMATCH', '进入的好友农场与所选 GID 不一致');
    return {
        gid: requestedGid,
        name: String(basic.remark || basic.name || `GID:${requestedGid}`),
        avatarUrl: String(basic.avatar_url || ''),
        isSelf: false,
    };
}

async function getDewTargets(hostGidInput: unknown = ''): Promise<DynamicRecord> {
    await requireActiveActivity();
    const host = currentHost(hostGidInput);
    if (host.isSelf) {
        const reply = await getAllLands();
        const lands = buildDewLandTargets(reply.lands, host);
        return { host, lands, count: lands.length, serverValidationRequired: true };
    }
    const enterReply = await enterFriendFarm(host.gid);
    try {
        const enteredHost = friendHost(enterReply, host.gid);
        const lands = buildDewLandTargets(enterReply.lands, enteredHost);
        return { host: enteredHost, lands, count: lands.length, serverValidationRequired: true };
    } finally {
        await leaveFriendFarm(host.gid);
    }
}

function findDewStack(bagReply: unknown): DynamicRecord | null {
    const stacks = getBagItems(bagReply)
        .map((item: unknown) => asRecord(item))
        .filter((item: DynamicRecord) => int64String(item.id ?? item.item_id) === String(DEW_ITEM_ID) && BigInt(int64String(item.count)) > 0n)
        .sort((left: DynamicRecord, right: DynamicRecord) => {
            const leftExpire = int64Number(left.expire_time) || Number.MAX_SAFE_INTEGER;
            const rightExpire = int64Number(right.expire_time) || Number.MAX_SAFE_INTEGER;
            return leftExpire - rightExpire;
        });
    return stacks[0] || null;
}

async function sendDewUse(stack: DynamicRecord, hostGid: string, landId: string): Promise<DynamicRecord> {
    const body = Buffer.from(types.UseRequest.encode(types.UseRequest.create({
        item: { id: DEW_ITEM_ID, count: 1, uid: stack.uid },
        target: { host_gid: toLong(hostGid), land_ids: [toLong(landId)], use_config_id: 0 },
    })).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.itempb.ItemService', 'Use', body);
    return types.UseReply.decode(replyBody);
}

function ensureDewApplied(reply: DynamicRecord): void {
    const usedItems = recordArray(reply.used_items);
    if (!usedItems.some(item => int64String(item.id ?? item.item_id) === String(DEW_ITEM_ID) && BigInt(int64String(item.count)) > 0n)) {
        // 抓包中不符合条件的地块返回空 UseReply，不报网关错误，也不会消耗灵露。
        throw businessError('QIXI_DEW_NO_EFFECT', '该地块未触发灵露效果，作物品级或状态可能不符合条件');
    }
}

async function useDew(hostGidInput: unknown, landIdInput: unknown): Promise<DynamicRecord> {
    await requireActiveActivity();
    const host = currentHost(hostGidInput);
    const landId = positiveInt64(landIdInput, 'INVALID_QIXI_DEW_LAND_ID', 'landId');
    const stack = findDewStack(await getBag());
    if (!stack) throw businessError('INSUFFICIENT_QIXI_DEW', '背包中没有可用的鹊羽灵露');

    let target: DynamicRecord | undefined;
    let reply: DynamicRecord;
    if (host.isSelf) {
        const landsReply = await getAllLands();
        target = buildDewLandTargets(landsReply.lands, host).find(entry => entry.landId === landId);
        if (!target) throw businessError('QIXI_DEW_TARGET_UNAVAILABLE', '所选地块已无可使用灵露的作物，请刷新后重选');
        reply = await sendDewUse(stack, host.gid, landId);
    } else {
        const enterReply = await enterFriendFarm(host.gid);
        try {
            const enteredHost = friendHost(enterReply, host.gid);
            target = buildDewLandTargets(enterReply.lands, enteredHost).find(entry => entry.landId === landId);
            if (!target) throw businessError('QIXI_DEW_TARGET_UNAVAILABLE', '所选地块已无可使用灵露的作物，请刷新后重选');
            reply = await sendDewUse(stack, host.gid, landId);
        } finally {
            await leaveFriendFarm(host.gid);
        }
    }
    ensureDewApplied(reply);
    const rewards = [...recordArray(reply.items), ...recordArray(asRecord(reply.land_reward).items)].map(itemDto);
    return {
        hostGid: host.gid,
        landId,
        target,
        usedItems: recordArray(reply.used_items).map(itemDto),
        rewards,
        message: `已在${host.isSelf ? '自己农场' : `${target?.ownerName || host.gid}的农场`}第 ${landId} 块地使用 1 份鹊羽灵露`,
    };
}

export {
    BRIDGE_ACTIVITY_ID,
    buildDewLandTargets,
    claimBridgeRewards,
    DEFAULT_GIFT_MESSAGE_TEXT_ID,
    DEW_ITEM_ID,
    ensureDewApplied,
    getCurrentQixiActivity,
    getDewTargets,
    GIFT_ACTIVITY_ID,
    giftSachet,
    GROUP_ID,
    hasAppliedQixiDew,
    normalizeGroup,
    qixiActivityIsActive,
    useDew,
};
