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
let pendingFoodUse: Promise<any> | null = null;

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

async function getDogInfo(): Promise<any> {
    const body = types.GetDogInfoRequest.encode(types.GetDogInfoRequest.create({})).finish();
    const reply = await sendMsgAsync('gamepb.dogpb.DogService', 'GetDogInfo', body);
    return types.GetDogInfoReply.decode(reply.body);
}

function buildPetSnapshot(reply: any, bagReply: any): any {
    const currentDogId = normalizeId(reply?.current_dog_id);
    const rawDogs = Array.isArray(reply?.dogs) ? reply.dogs : [];
    const byId = new Map(rawDogs.map((dog: any) => [normalizeId(dog?.id), dog]));
    const ids = [...new Set([...PET_IDS, ...rawDogs.map((dog: any) => normalizeId(dog?.id)).filter(Boolean)])];
    const dogs = ids.map((id) => {
        const raw: any = byId.get(id) || {};
        const item: any = getItemById(id) || {};
        const rarity = normalizeId(item?.rarity);
        return {
            id,
            name: String(raw?.name || item?.name || `宠物#${id}`),
            image: getItemImageById(id),
            rarity,
            rarityLabel: RARITY_LABELS[rarity] || '未知',
            level: normalizeId(raw?.level),
            price: normalizeId(raw?.price),
            owned: normalizeId(raw?.owned) === 1 || id === currentDogId,
            active: id === currentDogId,
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
        pendingGiftCount: normalizeId(reply?.pending_gift_count),
    };
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
    deployDog,
    didProtectDurationIncrease,
    getPetInfo,
    useDogFood,
    withdrawDog,
};
