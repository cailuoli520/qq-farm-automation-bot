export {};

const protobuf = require('protobufjs');
const {
    getItemById,
    getItemImageById,
    getPlantBySeedId,
    getPlantNameBySeedId,
    getSeedImageBySeedId,
} = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum } = require('../utils/utils');

const SERVICE = 'gamepb.illustratedpb.IllustratedService';

function rewardDto(input: any): any | null {
    const itemId = toNum(input?.item_id ?? input?.id);
    const count = Math.max(0, toNum(input?.count));
    if (!itemId) return null;
    const item = getItemById(itemId);
    return {
        itemId,
        count,
        name: String(item?.name || `物品${itemId}`),
        image: getItemImageById(itemId),
    };
}

function itemDto(input: any): any {
    const seedId = toNum(input?.seed_id);
    const plant = getPlantBySeedId(seedId);
    const item = getItemById(seedId);
    return {
        seedId,
        name: String(item?.name || plant?.name || getPlantNameBySeedId(seedId) || `种子${seedId}`),
        image: getSeedImageBySeedId(seedId) || getItemImageById(seedId),
        rewardCategory: toNum(input?.reward_category),
        cropCategory: toNum(input?.crop_category),
        unlocked: input?.unlocked === true,
        progress: Math.max(0, toNum(input?.progress)),
        isNew: input?.is_new === true,
        reward: rewardDto(input?.reward),
        attributes: (Array.isArray(input?.attributes) ? input.attributes : []).map((attribute: any) => ({
            type: toNum(attribute?.type),
            param: toNum(attribute?.param),
            value: toNum(attribute?.value),
        })),
    };
}

function normalizeBook(type: number, listReply: any, levelReply: any): any {
    const levels = (Array.isArray(levelReply?.levels) ? levelReply.levels : []).map((entry: any) => ({
        level: toNum(entry?.level),
        progress: Math.max(0, toNum(entry?.progress)),
        claimed: entry?.claimed === true,
        rewards: (Array.isArray(entry?.rewards) ? entry.rewards : []).map(rewardDto).filter(Boolean),
    }));
    const level = Math.max(toNum(listReply?.level), toNum(levelReply?.level));
    const progress = Math.max(toNum(listReply?.progress), toNum(levelReply?.progress));
    const nextLevel = levels.find((entry: any) => entry.level > level);
    return {
        type,
        level,
        progress,
        nextLevelProgress: toNum(listReply?.next_level_progress) || toNum(nextLevel?.progress),
        currentBonus: rewardDto(listReply?.current_bonus),
        attributeBonuses: (Array.isArray(listReply?.attribute_bonuses) ? listReply.attribute_bonuses : []).map(rewardDto).filter(Boolean),
        items: (Array.isArray(listReply?.items) ? listReply.items : []).map(itemDto),
        levels,
    };
}

async function getIllustratedList(type: number): Promise<any> {
    // 官方客户端显式编码 refresh=false；线上请求需保留 proto3 默认值字段。
    const writer = protobuf.Writer.create();
    writer.uint32(8).bool(false);
    writer.uint32(16).int32(type);
    const { body } = await sendMsgAsync(SERVICE, 'GetIllustratedListV2', writer.finish());
    return types.GetIllustratedListV2Reply.decode(body);
}

async function getIllustratedLevels(type: number): Promise<any> {
    const body = types.GetIllustratedLevelListV2Request.encode(
        types.GetIllustratedLevelListV2Request.create({ type }),
    ).finish();
    const reply = await sendMsgAsync(SERVICE, 'GetIllustratedLevelListV2', body);
    return types.GetIllustratedLevelListV2Reply.decode(reply.body);
}

async function getIllustratedSnapshot(
    loadList: (type: number) => Promise<any> = getIllustratedList,
    loadLevels: (type: number) => Promise<any> = getIllustratedLevels,
): Promise<any> {
    // 农场自动化与页面查询共用最多四个业务请求槽；串行读取避免图鉴一次占满
    // 全部槽位，并为心跳之外的常规任务保留并发余量。
    const cropList = await loadList(1);
    const cropLevels = await loadLevels(1);
    const mutantList = await loadList(2);
    const mutantLevels = await loadLevels(2);
    return {
        crop: normalizeBook(1, cropList, cropLevels),
        mutant: normalizeBook(2, mutantList, mutantLevels),
        updatedAt: Date.now(),
    };
}

module.exports = { getIllustratedSnapshot, normalizeBook };
