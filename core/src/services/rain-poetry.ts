/** 雨落成诗活动：发现、天气采集、召唤与研究解锁。 */

import type protobuf from 'protobufjs';
import { getServerTimeSec, toLong } from '../utils/utils';
import { sendMsgAsync } from '../utils/network';
import { types } from '../utils/proto';
import { bytesToText, int64Number, int64String, itemDto } from './activity-dto';
import { getActivityWindows } from './activity-windows';
import { withFriendVisit } from './friend-visit';
import { asRecord, recordArray } from './service-boundaries';

const { enterFriendFarm, leaveFriendFarm } = require('./friend-visit');
const { getBag, getBagItems, useItem } = require('./warehouse');

type DynamicRecord = Record<string, any>;
type TimeoutOrOptions = number | { timeoutMs?: number };

const GROUP_ID = '2026070300';
const EXCHANGE_ACTIVITY_ID = '2026070301';
const COLLECT_ACTIVITY_ID = '2026070303';
const RESEARCH_ACTIVITY_ID = '2026070304';
const TASK_ACTIVITY_ID = '2026070305';
const OPERATE_EXCHANGE = 1;
const OPERATE_COLLECT = 9;
const OPERATE_RESEARCH = 40;
const GOLD_BEAN_ITEM_ID = '1005';
const BADGE_ITEM_ID = '1027';
const COLLECTION_BOTTLE_ITEM_ID = '5001';
const THUNDERSTORM_BOTTLE_ITEM_ID = '5002';
const THUNDERSTORM_WEATHER_TYPE = '2';
const WEATHER_TYPE_NAMES: Readonly<Record<string, string>> = Object.freeze({
    '1': '普通雨天',
    [THUNDERSTORM_WEATHER_TYPE]: '雷雨',
});
const RAIN_ITEM_NAMES: Readonly<Record<string, string>> = Object.freeze({
    '1005': '金豆豆',
    '1027': '雷电徽章',
    '2159': '雨落成诗纪念奖励',
    '4002': '闪电变异瓶',
    '4003': '霹雳引雷瓶',
    '5001': '天气采集瓶',
    '5002': '雷雨召唤瓶',
});
const MAX_SIGNED_INT64 = 9223372036854775807n;
const RAIN_ACTIVITY_IDS = new Set([GROUP_ID, EXCHANGE_ACTIVITY_ID, '2026070302', COLLECT_ACTIVITY_ID, RESEARCH_ACTIVITY_ID, TASK_ACTIVITY_ID]);

class RainPoetryBusinessError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'RainPoetryBusinessError';
        this.code = code;
    }
}

function businessError(code: string, message: string): RainPoetryBusinessError {
    return new RainPoetryBusinessError(code, message);
}

function positiveInt64(value: unknown, code: string, fieldName: string): string {
    const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : String(value ?? '').trim();
    if (!/^[1-9]\d*$/.test(text) || text.length > 19 || BigInt(text) > MAX_SIGNED_INT64) {
        throw businessError(code, `${fieldName} 必须是 int64 范围内的正整数`);
    }
    return text;
}

function rainActivityIsActive(activityInput: unknown, serverTime = getServerTimeSec()): boolean {
    const activity = asRecord(activityInput);
    const beginTime = int64Number(activity.begin_time ?? activity.beginTime);
    const endTime = int64Number(activity.end_time ?? activity.endTime);
    return (beginTime <= 0 || serverTime >= beginTime) && (endTime <= 0 || serverTime <= endTime);
}

async function discoverActiveWindow(): Promise<DynamicRecord | null> {
    const windows = await getActivityWindows();
    const candidates = [...windows.values()].filter(window => RAIN_ACTIVITY_IDS.has(String(window.id)));
    const now = getServerTimeSec();
    const active = candidates.find(window => (window.beginTime <= 0 || now >= window.beginTime) && (window.endTime <= 0 || now <= window.endTime));
    return active ? { ...active, serverTime: now } : null;
}

async function queryGroup(timeoutOrOptions: TimeoutOrOptions = 20000): Promise<DynamicRecord> {
    const body = Buffer.from(types.GetGroupRequest.encode(types.GetGroupRequest.create({ group_id: toLong(GROUP_ID) })).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'GetGroup', body, timeoutOrOptions);
    return types.GetGroupReply.decode(replyBody);
}

async function queryWeather(timeoutOrOptions: TimeoutOrOptions = 20000): Promise<DynamicRecord> {
    const body = Buffer.from(types.GetWeatherStatusRequest.encode(types.GetWeatherStatusRequest.create({})).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.weatherpb.WeatherService', 'GetWeatherStatus', body, timeoutOrOptions);
    return types.GetWeatherStatusReply.decode(replyBody);
}

async function operate(requestType: protobuf.Type, payload: DynamicRecord): Promise<DynamicRecord> {
    const body = Buffer.from(requestType.encode(requestType.create(payload)).finish());
    const { body: replyBody } = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    return types.ActivityOperateReply.decode(replyBody);
}

function findChild(groupReply: unknown, activityId: string): DynamicRecord | null {
    return recordArray(asRecord(asRecord(groupReply).group).children)
        .find(child => int64String(asRecord(child.activity).activity_id) === activityId) || null;
}

function readBalances(bagReply: unknown): Map<string, string> {
    const wanted = new Set([GOLD_BEAN_ITEM_ID, BADGE_ITEM_ID, COLLECTION_BOTTLE_ITEM_ID, THUNDERSTORM_BOTTLE_ITEM_ID]);
    const balances = new Map<string, bigint>([...wanted].map(id => [id, 0n]));
    for (const item of getBagItems(bagReply)) {
        const source = asRecord(item);
        const id = int64String(source.id ?? source.item_id);
        if (!wanted.has(id)) continue;
        balances.set(id, (balances.get(id) || 0n) + BigInt(int64String(source.count)));
    }
    return new Map([...balances].map(([id, count]) => [id, count.toString()]));
}

function rainItem(value: unknown): DynamicRecord {
    const result = itemDto(value);
    const activityName = RAIN_ITEM_NAMES[result.id];
    return activityName ? { ...result, name: activityName } : result;
}

function parseRules(extra: unknown): { title: string; paragraphs: string[] } {
    const text = bytesToText(extra).trim();
    if (!text) return { title: '', paragraphs: [] };
    try {
        const parsed = JSON.parse(text);
        const tips = parsed && typeof parsed === 'object' ? parsed.tips : null;
        const paragraphs = Array.isArray(tips?.txt)
            ? tips.txt.filter((entry: unknown) => typeof entry === 'string')
                .map((entry: string) => entry.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()).filter(Boolean)
            : [];
        return { title: String(tips?.title || '').replace(/<[^>]+>/g, '').trim(), paragraphs };
    } catch {
        return { title: '', paragraphs: [] };
    }
}

function normalizeWeather(reply: unknown): DynamicRecord {
    const source = asRecord(reply);
    const status = asRecord(source.status ?? source);
    const type = int64String(status.weather_type);
    const active = !!status.active && type !== '0';
    return {
        weatherId: int64String(status.weather_id),
        type,
        name: active ? (WEATHER_TYPE_NAMES[type] || `特殊天气（类型 ${type}）`) : '晴朗',
        startTime: int64String(status.begin_time),
        endTime: int64String(status.end_time),
        active,
        thunderstorm: active && type === THUNDERSTORM_WEATHER_TYPE,
    };
}

function normalizeGroup(groupReply: unknown, bagReply: unknown, weatherReply: unknown): DynamicRecord {
    const group = asRecord(asRecord(groupReply).group);
    const groupActivity = asRecord(group.activity);
    const exchangeChild = findChild(groupReply, EXCHANGE_ACTIVITY_ID);
    const collectChild = findChild(groupReply, COLLECT_ACTIVITY_ID);
    const researchChild = findChild(groupReply, RESEARCH_ACTIVITY_ID);
    const taskChild = findChild(groupReply, TASK_ACTIVITY_ID);
    if (!exchangeChild || !collectChild || !researchChild || !taskChild || int64String(groupActivity.activity_id) !== GROUP_ID) {
        throw businessError('RAIN_POETRY_UNAVAILABLE', '服务端未返回完整的雨落成诗活动组');
    }
    const active = rainActivityIsActive(groupActivity);
    const balances = bagReply ? readBalances(bagReply) : null;
    const balancesKnown = balances !== null;
    const balance = (id: string) => balances?.get(id) || '0';
    const canAfford = (item: DynamicRecord) => (
        balancesKnown && BigInt(balance(item.id)) >= BigInt(item.count || '0')
    );
    const weatherKnown = weatherReply !== null && weatherReply !== undefined;
    const weather = normalizeWeather(weatherReply);
    const goods = recordArray(asRecord(exchangeChild.catalog).goods).map((entry) => {
        const source = asRecord(entry);
        const owned = !!source.owned;
        const cost = rainItem(source.cost);
        return {
            id: int64String(source.goods_id),
            item: rainItem(source.item),
            cost,
            owned,
            available: active && !owned && canAfford(cost),
        };
    });
    const tasks = recordArray(asRecord(taskChild.weather_tasks).tasks).map((entry) => ({
        id: int64String(entry.task_id),
        name: String(entry.name || ''),
        itemId: int64String(entry.item_id),
        progress: int64String(entry.progress),
        target: int64String(entry.target),
        reward: rainItem(entry.reward),
        completed: int64Number(entry.target) > 0 && int64Number(entry.progress) >= int64Number(entry.target),
    }));
    const nodes = recordArray(asRecord(researchChild.weather_research).groups).flatMap(groupEntry => (
        recordArray(groupEntry.nodes).map((entry) => {
            const statusCode = int64String(entry.status);
            const prerequisites = Array.isArray(entry.prerequisite_ids) ? entry.prerequisite_ids.map(int64String) : [];
            const cost = rainItem(entry.cost);
            const claimed = !!entry.claimed || statusCode === '4';
            const unlockable = active && !claimed && statusCode === '2' && canAfford(cost);
            return {
                id: int64String(entry.node_id),
                prerequisites,
                statusCode,
                claimed,
                unlockable,
                cost,
                reward: rainItem(entry.reward),
                premium: !!entry.premium,
                premiumValue: int64String(entry.premium_value),
            };
        })
    ));
    const claimedNodeIds = new Set(nodes.filter(node => node.claimed).map(node => node.id));
    for (const node of nodes) {
        node.unlockable = node.unlockable && node.prerequisites.every((id: string) => claimedNodeIds.has(id));
    }
    return {
        groupId: GROUP_ID,
        activityId: EXCHANGE_ACTIVITY_ID,
        name: bytesToText(groupActivity.name) || '雨落成诗',
        startTime: int64String(groupActivity.begin_time),
        endTime: int64String(groupActivity.end_time),
        serverTime: String(getServerTimeSec()),
        active,
        rules: parseRules(asRecord(exchangeChild.activity).extra),
        balances: {
            goldBean: balance(GOLD_BEAN_ITEM_ID),
            badge: balance(BADGE_ITEM_ID),
            collectionBottle: balance(COLLECTION_BOTTLE_ITEM_ID),
            thunderstormBottle: balance(THUNDERSTORM_BOTTLE_ITEM_ID),
            known: balancesKnown,
        },
        items: {
            goldBean: rainItem({ item_id: GOLD_BEAN_ITEM_ID, count: balance(GOLD_BEAN_ITEM_ID) }),
            badge: rainItem({ item_id: BADGE_ITEM_ID, count: balance(BADGE_ITEM_ID) }),
            collectionBottle: rainItem({ item_id: COLLECTION_BOTTLE_ITEM_ID, count: balance(COLLECTION_BOTTLE_ITEM_ID) }),
            thunderstormBottle: rainItem({ item_id: THUNDERSTORM_BOTTLE_ITEM_ID, count: balance(THUNDERSTORM_BOTTLE_ITEM_ID) }),
        },
        weather: { ...weather, known: weatherKnown },
        exchangeItems: goods,
        tasks,
        researchNodes: nodes,
        actions: {
            exchange: { enabled: goods.some(entry => entry.available), available: goods.some(entry => entry.available), availabilityKnown: balancesKnown },
            collect: { enabled: active && balancesKnown && BigInt(balance(COLLECTION_BOTTLE_ITEM_ID)) > 0n, available: active && balancesKnown && BigInt(balance(COLLECTION_BOTTLE_ITEM_ID)) > 0n, availabilityKnown: balancesKnown },
            thunderstorm: { enabled: active && balancesKnown && weatherKnown && !weather.active && BigInt(balance(THUNDERSTORM_BOTTLE_ITEM_ID)) > 0n, available: active && balancesKnown && weatherKnown && !weather.active && BigInt(balance(THUNDERSTORM_BOTTLE_ITEM_ID)) > 0n, availabilityKnown: balancesKnown && weatherKnown },
            research: { enabled: nodes.some(node => node.unlockable), available: nodes.some(node => node.unlockable), availabilityKnown: balancesKnown },
        },
    };
}

async function getCurrentRainPoetryActivity(
    bagInput: unknown = null,
    timeoutOrOptions: TimeoutOrOptions = 20000,
): Promise<DynamicRecord | null> {
    if (!await discoverActiveWindow()) return null;
    const groupReply = await queryGroup(timeoutOrOptions);
    let bagReply: unknown = null;
    let weatherReply: unknown = null;
    try {
        bagReply = await Promise.resolve(bagInput || getBag(timeoutOrOptions));
    } catch {
        // 背包查询失败时仍展示活动，所有依赖余额的写操作保持禁用。
    }
    try {
        weatherReply = await queryWeather(timeoutOrOptions);
    } catch {
        // 天气查询失败时仍展示活动，但不允许使用天气道具。
    }
    return normalizeGroup(groupReply, bagReply, weatherReply);
}

async function requireActivity(): Promise<DynamicRecord> {
    const activity = await getCurrentRainPoetryActivity();
    if (!activity?.active) throw businessError('RAIN_POETRY_UNAVAILABLE', '雨落成诗活动未开放或已经结束');
    return activity;
}

async function withFriendFarm<T>(
    friendGid: string,
    operation: (enterReply: DynamicRecord) => Promise<T>,
    enter: (gid: string) => Promise<DynamicRecord> = enterFriendFarm,
    leave: (gid: string) => Promise<unknown> = leaveFriendFarm,
): Promise<T> {
    return withFriendVisit({ source: 'manual', friendGid, enter, leave }, ({ enterReply }) => operation(enterReply));
}

function ensureRainCollectionResult(reply: unknown): { received: DynamicRecord; consumed: DynamicRecord } {
    const result = asRecord(asRecord(reply).weather_collection_result);
    const received = rainItem(result.received_item);
    const consumed = rainItem(result.consumed_item);
    if (received.id !== THUNDERSTORM_BOTTLE_ITEM_ID || BigInt(received.count || '0') < 1n || consumed.id !== COLLECTION_BOTTLE_ITEM_ID || BigInt(consumed.count || '0') < 1n) {
        throw businessError('RAIN_RESPONSE_INVALID', '天气采集回包未确认消耗与奖励');
    }
    return { received, consumed };
}

function requireUnlockableResearchNode(activity: DynamicRecord, nodeId: string): DynamicRecord {
    const node = recordArray(activity.researchNodes).find(entry => String(entry.id || '') === nodeId);
    if (!node || node.claimed || !node.unlockable) throw businessError('RAIN_RESEARCH_UNAVAILABLE', '该研究节点尚不可解锁或余额不足');
    return node;
}

async function getRainPoetryWeather(friendGidInput: unknown = ''): Promise<DynamicRecord> {
    await requireActivity();
    const raw = String(friendGidInput ?? '').trim();
    if (!raw) return { host: { gid: '', name: '我的农场', isSelf: true }, weather: normalizeWeather(await queryWeather()) };
    const friendGid = positiveInt64(raw, 'INVALID_RAIN_FRIEND_GID', 'friendGid');
    return withFriendFarm(friendGid, async (enterReply) => {
        const basic = asRecord(enterReply.basic);
        const actualGid = int64String(basic.gid);
        if (actualGid !== '0' && actualGid !== friendGid) throw businessError('RAIN_FRIEND_MISMATCH', '进入的好友农场与所选 GID 不一致');
        return {
            host: { gid: friendGid, name: String(basic.remark || basic.name || `GID:${friendGid}`), avatarUrl: String(basic.avatar_url || ''), isSelf: false },
            weather: normalizeWeather(enterReply.weather_status),
        };
    });
}

async function exchangeRainBottle(goodsIdInput: unknown = '200', countInput: unknown = 1): Promise<DynamicRecord> {
    const goodsId = positiveInt64(goodsIdInput, 'INVALID_RAIN_GOODS_ID', 'goodsId');
    const count = positiveInt64(countInput, 'INVALID_RAIN_EXCHANGE_COUNT', 'count');
    const activity = await requireActivity();
    const goods = activity.exchangeItems.find((entry: DynamicRecord) => entry.id === goodsId);
    if (!goods?.available || count !== '1') throw businessError('RAIN_EXCHANGE_UNAVAILABLE', '该天气瓶当前不可兑换');
    const reply = await operate(types.ExchangeShopRequest, {
        activity_id: toLong(EXCHANGE_ACTIVITY_ID), operate_type: OPERATE_EXCHANGE,
        exchange_shop_operate: { goods_id: toLong(goodsId), count: toLong(count) },
    });
    if (int64String(reply.activity_id) !== EXCHANGE_ACTIVITY_ID || int64String(reply.operate_type) !== String(OPERATE_EXCHANGE)) {
        throw businessError('RAIN_RESPONSE_INVALID', '天气瓶兑换回包与请求不匹配');
    }
    const result = asRecord(reply.weather_exchange_result);
    const received = rainItem(result.received_item);
    if (received.id !== COLLECTION_BOTTLE_ITEM_ID || BigInt(received.count) < 1n) throw businessError('RAIN_RESPONSE_INVALID', '天气瓶兑换回包未确认获得物品');
    return { rewards: [received], message: '已兑换 1 个天气采集瓶' };
}

async function collectRainWeather(friendGidInput: unknown): Promise<DynamicRecord> {
    const friendGid = positiveInt64(friendGidInput, 'INVALID_RAIN_FRIEND_GID', 'friendGid');
    const activity = await requireActivity();
    if (!activity.actions.collect.enabled) throw businessError('RAIN_COLLECT_UNAVAILABLE', '背包中没有可用的天气采集瓶');
    return withFriendFarm(friendGid, enterReply => collectRainWeatherFromVisit(friendGid, enterReply, activity));
}

async function collectRainWeatherFromVisit(
    friendGidInput: unknown,
    enterReplyInput: unknown,
    activityInput: unknown = null,
): Promise<DynamicRecord> {
    const friendGid = positiveInt64(friendGidInput, 'INVALID_RAIN_FRIEND_GID', 'friendGid');
    const activity = activityInput ? asRecord(activityInput) : await requireActivity();
    if (!activity.active || !rainActivityIsActive(activity) || !activity.actions?.collect?.enabled) {
        throw businessError('RAIN_COLLECT_UNAVAILABLE', '背包中没有可用的天气采集瓶');
    }
    const enterReply = asRecord(enterReplyInput);
    const basic = asRecord(enterReply.basic);
    const actualGid = int64String(basic.gid);
    if (actualGid !== '0' && actualGid !== friendGid) {
        throw businessError('RAIN_FRIEND_MISMATCH', '进入的好友农场与所选 GID 不一致');
    }
    const weather = normalizeWeather(enterReply.weather_status);
    if (!weather.thunderstorm) throw businessError('RAIN_WEATHER_UNAVAILABLE', '该好友农场当前不是雷雨天气');
    const reply = await operate(types.CollectRainWeatherRequest, {
        activity_id: toLong(COLLECT_ACTIVITY_ID), operate_type: OPERATE_COLLECT,
        params: { target_gid: toLong(friendGid) },
    });
    if (int64String(reply.activity_id) !== COLLECT_ACTIVITY_ID || int64String(reply.operate_type) !== String(OPERATE_COLLECT)) {
        throw businessError('RAIN_RESPONSE_INVALID', '天气采集回包与请求不匹配');
    }
    const { received, consumed } = ensureRainCollectionResult(reply);
    return { friendGid, rewards: [received], consumedItems: [consumed], message: '采集成功，获得 1 个雷雨召唤瓶' };
}

async function useRainThunderstorm(): Promise<DynamicRecord> {
    const activity = await requireActivity();
    if (!activity.actions.thunderstorm.enabled) throw businessError('RAIN_THUNDERSTORM_UNAVAILABLE', '当前天气或背包状态不允许召唤雷雨');
    const reply = asRecord(await useItem(THUNDERSTORM_BOTTLE_ITEM_ID, 1));
    const used = recordArray(reply.used_items).map(rainItem);
    if (!used.some(item => item.id === THUNDERSTORM_BOTTLE_ITEM_ID && BigInt(item.count) > 0n)) {
        throw businessError('RAIN_RESPONSE_INVALID', '雷雨召唤回包未确认消耗道具');
    }
    return { usedItems: used, rewards: recordArray(reply.items).map(rainItem), message: '已使用雷雨召唤瓶' };
}

async function unlockRainResearch(nodeIdInput: unknown): Promise<DynamicRecord> {
    const nodeId = positiveInt64(nodeIdInput, 'INVALID_RAIN_RESEARCH_NODE', 'nodeId');
    const activity = await requireActivity();
    requireUnlockableResearchNode(activity, nodeId);
    const reply = await operate(types.UnlockRainResearchRequest, {
        activity_id: toLong(RESEARCH_ACTIVITY_ID), operate_type: OPERATE_RESEARCH,
        params: { node_id: toLong(nodeId) },
    });
    if (int64String(reply.activity_id) !== RESEARCH_ACTIVITY_ID || int64String(reply.operate_type) !== String(OPERATE_RESEARCH)) {
        throw businessError('RAIN_RESPONSE_INVALID', '气象研究回包与请求不匹配');
    }
    const result = asRecord(reply.weather_research_result);
    if (int64String(result.node_id) !== nodeId) throw businessError('RAIN_RESPONSE_INVALID', '气象研究回包节点与请求不匹配');
    const reward = rainItem(result.reward);
    return { nodeId, unlockedNodeIds: Array.isArray(result.unlocked_node_ids) ? result.unlocked_node_ids.map(int64String) : [], rewards: reward.id !== '0' ? [reward] : [], message: `已解锁气象研究节点 ${nodeId}` };
}

export {
    collectRainWeather,
    collectRainWeatherFromVisit,
    ensureRainCollectionResult,
    exchangeRainBottle,
    getCurrentRainPoetryActivity,
    getRainPoetryWeather,
    GROUP_ID,
    normalizeGroup,
    normalizeWeather,
    rainActivityIsActive,
    requireUnlockableResearchNode,
    unlockRainResearch,
    useRainThunderstorm,
    withFriendFarm,
};
