export {};

const { getItemById, getItemImageById } = require('../config/gameConfig');
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { log, logWarn, toNum } = require('../utils/utils');
const { getBag, getBagItems } = require('./warehouse');

const MAX_PROTECT_DURATION_SECONDS = 30 * 24 * 60 * 60;
const PET_IDS = [90001, 90002, 90003, 90011, 90021];
const DOG_FOOD_DURATIONS = new Map([
    [90004, 24 * 60 * 60],
    [90005, 3 * 24 * 60 * 60],
    [90006, 5 * 24 * 60 * 60],
]);
const RARITY_LABELS: Record<number, string> = { 1: '普通', 2: '稀有', 3: '珍品', 4: '天工' };
const PET_OBTAIN_CONDITIONS: Record<number, string> = {
    90001: '参与分享任务可获得',
    90002: '商店购买：100 点券',
    90003: '商店购买：200 点券',
    90011: '商店购买：200 点券',
    90021: '限时活动获得',
};
const PET_SKILLS: Record<number, Array<Record<string, unknown>>> = {
    90001: [{ name: '忠心护主', description: '作物被偷时，有 10% 概率触发看护，成功后扣除偷窃者一定金币。', triggerRate: 10, source: 'game-config' }],
    90002: [{ name: '忠心护主', description: '作物被偷时，有 30% 概率触发看护，成功后扣除偷窃者一定金币。', triggerRate: 30, source: 'game-config' }],
    90003: [{ name: '忠心护主', description: '作物被偷时，有 50% 概率触发看护，成功后扣除偷窃者一定金币。', triggerRate: 50, source: 'game-config' }],
    90011: [{ name: '忠心护主', description: '作物被偷时，有 50% 概率触发看护，成功后扣除偷窃者一定金币。', triggerRate: 50, source: 'game-config' }],
    90021: [
        { name: '忠心护主', description: '作物被偷时，有 50% 概率触发看护，成功后扣除偷窃者一定金币。', triggerRate: 50, source: 'game-config' },
        { skillId: 2001, name: '同气连枝', description: '好友协助浇水、除草或除虫时有概率掉落双方均可获得的礼包，每日最多 30 次。', dailyLimit: 30, source: 'client-static' },
    ],
};
let pendingFoodUse: Promise<any> | null = null;
let pendingGiftClaim: Promise<any> | null = null;

function normalizeId(value: unknown): number {
    return Math.max(0, toNum(value));
}

function isPositiveSafeInteger(value: unknown): boolean {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0;
}

function didProtectDurationIncrease(before: unknown, after: unknown): boolean {
    return normalizeId(after) > normalizeId(before);
}

function isLocked(item: any): boolean {
    return item?.locked === true || item?.locked === 1 || item?.locked === '1';
}

function getPendingGiftCount(reply: any): number {
    return normalizeId(reply?.pending_gift_count ?? reply?.pendingGiftCount);
}

function getClaimedGiftCount(reply: any): number {
    const claimedCount = normalizeId(reply?.claimed_count ?? reply?.claimedCount);
    return claimedCount || normalizeId(reply?.item?.count);
}

function didPendingGiftCountDecrease(before: unknown, after: unknown): boolean {
    return normalizeId(after) < normalizeId(before);
}

function getPetSkills(id: number, item: any, skillUsages: any[]): Array<Record<string, unknown>> {
    const definitions = PET_SKILLS[id] || [{
        name: '看护',
        description: String(item?.desc || item?.effectDesc || '暂无技能说明'),
        source: 'game-config',
    }];
    return definitions.map((definition) => {
        const skillId = normalizeId(definition.skillId);
        if (!skillId) return { ...definition };
        const usage = skillUsages.find((entry: any) => (
            normalizeId(entry?.skill_id ?? entry?.skillId) === skillId
            && normalizeId(entry?.dog_id ?? entry?.dogId) === id
        ));
        if (!usage) return { ...definition };
        const usedCount = normalizeId(usage?.used_count ?? usage?.usedCount);
        const dailyLimit = normalizeId(usage?.daily_limit ?? usage?.dailyLimit) || normalizeId(definition.dailyLimit);
        return {
            ...definition,
            dailyLimit,
            usedCount,
            remainingCount: Math.max(0, dailyLimit - usedCount),
        };
    });
}

async function getDogInfo(): Promise<any> {
    const body = types.GetDogInfoRequest.encode(types.GetDogInfoRequest.create({})).finish();
    const reply = await sendMsgAsync('gamepb.dogpb.DogService', 'GetDogInfo', body);
    return types.GetDogInfoReply.decode(reply.body);
}

function buildPetSnapshot(reply: any, bagReply: any): any {
    const currentDogId = normalizeId(reply?.current_dog_id);
    const rawDogs = Array.isArray(reply?.dogs) ? reply.dogs : [];
    const skillUsages = Array.isArray(reply?.skill_usages) ? reply.skill_usages : [];
    const byId = new Map(rawDogs.map((dog: any) => [normalizeId(dog?.id), dog]));
    const ids = [...new Set([...PET_IDS, ...rawDogs.map((dog: any) => normalizeId(dog?.id)).filter(Boolean)])];
    const dogs = ids.map((id) => {
        const raw: any = byId.get(id) || {};
        const item: any = getItemById(id) || {};
        const rarity = normalizeId(item?.rarity);
        const skills = getPetSkills(id, item, skillUsages);
        return {
            id,
            name: String(raw?.name || item?.name || `宠物#${id}`),
            image: getItemImageById(id),
            rarity,
            rarityLabel: RARITY_LABELS[rarity] || '未知',
            level: normalizeId(raw?.level),
            status: normalizeId(raw?.status),
            price: normalizeId(raw?.price),
            owned: normalizeId(raw?.owned) === 1 || id === currentDogId,
            active: id === currentDogId,
            obtainCondition: PET_OBTAIN_CONDITIONS[id] || '游戏内活动或购买获得',
            skills,
            skillDescription: String(skills[0]?.description || '暂无技能说明'),
        };
    });
    const bagItems = getBagItems(bagReply);
    const foods = [...DOG_FOOD_DURATIONS.entries()].map(([id, duration]) => {
        const item: any = getItemById(id) || {};
        const count = bagItems
            .filter((entry: any) => normalizeId(entry?.id) === id && !isLocked(entry))
            .reduce((sum: number, entry: any) => sum + normalizeId(entry?.count), 0);
        return { id, duration, count, name: String(item?.name || `狗粮#${id}`), image: getItemImageById(id) };
    });
    const protectDuration = normalizeId(reply?.protect_time);
    return {
        dogs,
        foods,
        activeDogId: currentDogId,
        protectDuration,
        maxProtectDuration: Math.max(protectDuration, normalizeId(reply?.max_protect_time) || MAX_PROTECT_DURATION_SECONDS),
        remainingDuration: protectDuration,
        pendingGiftCount: getPendingGiftCount(reply),
        activeControlSupported: true,
        guardianRecordsSupported: true,
    };
}

function decodeText(value: unknown): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    return String(value);
}

async function getProtectLogs(): Promise<any> {
    const body = types.GetProtectLogsRequest.encode(types.GetProtectLogsRequest.create({
        field_1: 0,
        count: 100,
        field_3: 0,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.dogpb.DogService', 'GetProtectLogs', body);
    const reply = types.GetProtectLogsReply.decode(replyBody);
    const logs = (Array.isArray(reply?.logs) ? reply.logs : []).map((entry: any, index: number) => {
        const friendGid = normalizeId(entry?.friend_gid ?? entry?.friendGid);
        const timestamp = normalizeId(entry?.timestamp);
        return {
            id: `${friendGid}-${timestamp}-${index}`,
            friendGid,
            friendName: decodeText(entry?.friend_name ?? entry?.friendName) || `用户#${friendGid}`,
            friendAvatar: String(entry?.friend_avatar ?? entry?.friendAvatar ?? ''),
            timestamp,
            stolenCount: normalizeId(entry?.stolen_count ?? entry?.stolenCount),
            protectedGold: normalizeId(entry?.protected_gold ?? entry?.protectedGold),
            dogId: normalizeId(entry?.dog_id ?? entry?.dogId),
            dogName: String(entry?.dog_name ?? entry?.dogName ?? ''),
        };
    });
    return { logs, total: Math.max(logs.length, normalizeId(reply?.total)), offset: 0, limit: 100 };
}

async function claimDogSkillGifts(_pendingCountHint?: unknown): Promise<any> {
    if (pendingGiftClaim) return pendingGiftClaim;
    const request = (async () => {
        const before = await getDogInfo();
        // 领取前已向服务器刷新状态，必须以服务器值为准；页面提示可能已过期，
        // 不能据此发送重复领取请求。
        const beforeCount = getPendingGiftCount(before);
        if (beforeCount <= 0) return { claimed: 0, pending: 0, item: null };

        const body = types.ClaimSkillGiftsRequest.encode(types.ClaimSkillGiftsRequest.create({})).finish();
        let decoded: any = null;
        try {
            const { body: replyBody } = await sendMsgAsync('gamepb.dogpb.DogService', 'ClaimSkillGifts', body);
            decoded = types.ClaimSkillGiftsReply.decode(replyBody);
        } catch (error) {
            let confirmed: any = null;
            try {
                confirmed = await getDogInfo();
            } catch { }
            const confirmedCount = confirmed ? getPendingGiftCount(confirmed) : beforeCount;
            if (!confirmed || !didPendingGiftCountDecrease(beforeCount, confirmedCount)) throw error;
            const claimed = beforeCount - confirmedCount;
            logWarn('宠物', '礼包领取回包失败，但复查确认待领取数量已减少，按成功处理', {
                module: 'dog', event: '领取同气连枝礼包复查', result: 'reconciled', claimed,
            });
            return { claimed, pending: confirmedCount, item: null };
        }

        let after: any = null;
        try {
            after = await getDogInfo();
        } catch { }
        const replyClaimedCount = getClaimedGiftCount(decoded);
        const afterCount = after ? getPendingGiftCount(after) : Math.max(0, beforeCount - replyClaimedCount);
        const claimed = Math.max(replyClaimedCount, Math.max(0, beforeCount - afterCount));
        if (claimed <= 0) throw new Error('礼包待领取数量未减少，请稍后重试');
        const item = decoded?.item || null;
        const itemId = normalizeId(item?.id);
        const itemName = String(getItemById(itemId)?.name || (itemId ? `物品#${itemId}` : '同气连枝礼包'));
        log('宠物', `已领取${itemName} x${claimed}`, {
            module: 'dog', event: '领取同气连枝礼包', result: 'ok', itemId, claimed,
        });
        return { claimed, pending: afterCount, item };
    })();
    pendingGiftClaim = request;
    try {
        return await request;
    } finally {
        if (pendingGiftClaim === request) pendingGiftClaim = null;
    }
}

async function getPetInfo(): Promise<any> {
    const dogReply = await getDogInfo();
    const bagReply = await getBag();
    return buildPetSnapshot(dogReply, bagReply);
}

async function buildReconciledFoodSnapshot(dogReply: any): Promise<any> {
    try {
        return buildPetSnapshot(dogReply, await getBag());
    } catch (error) {
        // 写操作已确认成功时，背包刷新失败不能再向调用方报告写失败，否则会诱导重复使用。
        logWarn('宠物', `狗粮已生效，但背包刷新失败: ${error instanceof Error ? error.message : String(error)}`, {
            module: 'dog', event: '使用狗粮复查', result: 'snapshot_partial',
        });
        return buildPetSnapshot(dogReply, { items: [] });
    }
}

async function deployDog(dogIdInput: unknown): Promise<any> {
    if (!isPositiveSafeInteger(dogIdInput)) throw new Error('宠物 ID 无效');
    const dogId = normalizeId(dogIdInput);
    const before = await getDogInfo();
    const dog = (before?.dogs || []).find((entry: any) => normalizeId(entry?.id) === dogId);
    if (!dog || normalizeId(dog?.owned) !== 1) throw new Error('未获得该宠物，无法上场');
    const body = types.DeployDogRequest.encode(types.DeployDogRequest.create({ dog_id: dogId })).finish();
    await sendMsgAsync('gamepb.dogpb.DogService', 'DeployDog', body);
    const snapshot = await getPetInfo();
    if (snapshot.activeDogId !== dogId) throw new Error('宠物上场状态未更新，请稍后重试');
    log('宠物', `已上场${dog?.name || `宠物#${dogId}`}`, { module: 'dog', event: '上场宠物', result: 'ok', dogId });
    return snapshot;
}

async function withdrawDog(): Promise<any> {
    const before = await getDogInfo();
    const dogId = normalizeId(before?.current_dog_id);
    if (!dogId) return getPetInfo();
    const body = types.WithdrawDogRequest.encode(types.WithdrawDogRequest.create({})).finish();
    await sendMsgAsync('gamepb.dogpb.DogService', 'WithdrawDog', body);
    const snapshot = await getPetInfo();
    if (snapshot.activeDogId) throw new Error('宠物收回状态未更新，请稍后重试');
    log('宠物', '已收回当前宠物', { module: 'dog', event: '收回宠物', result: 'ok', dogId });
    return snapshot;
}

async function useDogFood(itemIdInput: unknown, countInput: unknown = 1): Promise<any> {
    if (!isPositiveSafeInteger(itemIdInput)) throw new Error('狗粮物品 ID 无效');
    if (!isPositiveSafeInteger(countInput)) throw new Error('狗粮使用数量必须为正整数');
    const itemId = normalizeId(itemIdInput);
    const count = normalizeId(countInput);
    const duration = DOG_FOOD_DURATIONS.get(itemId) || 0;
    if (!duration) throw new Error('该物品不是可用狗粮');
    if (pendingFoodUse) throw new Error('已有狗粮使用请求正在处理，请稍后再试');
    const request = (async () => {
        const before = await getDogInfo();
        if (!normalizeId(before?.current_dog_id)) throw new Error('请先让宠物上场再使用狗粮');
        const currentDuration = normalizeId(before?.protect_time);
        const maxDuration = normalizeId(before?.max_protect_time) || MAX_PROTECT_DURATION_SECONDS;
        if (currentDuration + duration * count > maxDuration) throw new Error('狗粮使用后将超过 30 天上限');
        const bag = await getBag();
        const available = getBagItems(bag)
            .filter((item: any) => normalizeId(item?.id) === itemId && !isLocked(item))
            .reduce((sum: number, item: any) => sum + normalizeId(item?.count), 0);
        if (available < count) throw new Error(`狗粮可用数量不足：需要 ${count}，当前 ${available}`);
        const body = types.AddFoodRequest.encode(types.AddFoodRequest.create({ item_id: itemId, count })).finish();
        let reply: any;
        try {
            reply = await sendMsgAsync('gamepb.dogpb.DogService', 'AddFood', body);
        } catch (error) {
            // 写请求可能已被服务器处理但回包丢失；复查后确认生效，避免用户重试重复消耗。
            let confirmedDog: any = null;
            try {
                confirmedDog = await getDogInfo();
            } catch {
                // 复查失败时保留原始写请求错误，便于定位真实原因。
            }
            if (didProtectDurationIncrease(currentDuration, confirmedDog?.protect_time)) {
                logWarn('宠物', '狗粮使用回包失败，但复查确认保护时间已增加，按成功处理', {
                    module: 'dog', event: '使用狗粮复查', result: 'reconciled', itemId, count,
                });
                return buildReconciledFoodSnapshot(confirmedDog);
            }
            throw error;
        }
        const decoded = types.AddFoodReply.decode(reply.body);
        if (!didProtectDurationIncrease(currentDuration, decoded?.protect_time)) {
            const confirmedDog = await getDogInfo();
            if (!didProtectDurationIncrease(currentDuration, confirmedDog?.protect_time)) {
                throw new Error('狗粮剩余时间未更新，请稍后重试');
            }
            logWarn('宠物', '狗粮回复未携带新保护时间，但复查确认已生效', {
                module: 'dog', event: '使用狗粮复查', result: 'reconciled', itemId, count,
            });
            return buildReconciledFoodSnapshot(confirmedDog);
        }
        log('宠物', `使用${getItemById(itemId)?.name || `狗粮#${itemId}`} x${count}`, { module: 'dog', event: '使用狗粮', result: 'ok', itemId, count });
        return getPetInfo();
    })();
    pendingFoodUse = request;
    try {
        return await request;
    } catch (error: any) {
        logWarn('宠物', `使用狗粮失败: ${error?.message || error}`, { module: 'dog', event: '使用狗粮', result: 'error', itemId, count });
        throw error;
    } finally {
        if (pendingFoodUse === request) pendingFoodUse = null;
    }
}

module.exports = {
    MAX_PROTECT_DURATION_SECONDS,
    buildPetSnapshot,
    claimDogSkillGifts,
    deployDog,
    didPendingGiftCountDecrease,
    didProtectDurationIncrease,
    getClaimedGiftCount,
    getPendingGiftCount,
    getPetInfo,
    getProtectLogs,
    useDogFood,
    withdrawDog,
};
