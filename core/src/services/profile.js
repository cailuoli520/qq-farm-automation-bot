const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum } = require('../utils/utils');

function normalizeLong(value) {
    return toNum(value);
}

function normalizeDogInfo(reply) {
    const dogs = Array.isArray(reply && reply.dogs) ? reply.dogs : [];
    const foods = Array.isArray(reply && reply.foods) ? reply.foods : [];
    return {
        dogs: dogs.map(dog => ({
            id: normalizeLong(dog.id),
            name: String(dog.name || ''),
            status: toNum(dog.status),
            intimacy: toNum(dog.intimacy),
            equipped: !!dog.equipped,
        })),
        equippedDogId: normalizeLong(reply && reply.equipped_dog_id),
        guardLeftSeconds: normalizeLong(reply && reply.guard_left_seconds),
        guardTotalSeconds: normalizeLong(reply && reply.guard_total_seconds),
        foods: foods.map(food => ({
            id: normalizeLong(food.id),
            count: normalizeLong(food.count),
            extra: normalizeLong(food.extra),
        })),
    };
}

function normalizeSkinList(reply, key = 'skins') {
    const list = Array.isArray(reply && reply[key]) ? reply[key] : [];
    return list.map(item => ({
        id: normalizeLong(item.id),
        type: toNum(item.type),
        expireAt: normalizeLong(item.expire_at),
        equipped: !!item.equipped,
        source: toNum(item.source),
    }));
}

function normalizeAvatarFrames(reply) {
    const frames = Array.isArray(reply && reply.frames) ? reply.frames : [];
    return frames.map(frame => ({
        id: normalizeLong(frame.id),
        type: toNum(frame.type),
        expireAt: normalizeLong(frame.expire_at),
        equipped: !!frame.equipped,
    }));
}

async function getDogInfo() {
    const body = types.GetDogInfoRequest.encode(types.GetDogInfoRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.dogpb.DogService', 'GetDogInfo', body);
    return normalizeDogInfo(types.GetDogInfoReply.decode(replyBody));
}

async function getSkinsOwned() {
    const body = types.SkinsOwnedRequest.encode(types.SkinsOwnedRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.skinpb.SkinService', 'SkinsOwned', body);
    return normalizeSkinList(types.SkinsOwnedReply.decode(replyBody));
}

async function getSkinsEquipped() {
    const body = types.SkinsEquippedRequest.encode(types.SkinsEquippedRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.skinpb.SkinService', 'SkinsEquipped', body);
    return normalizeSkinList(types.SkinsEquippedReply.decode(replyBody));
}

async function getAvatarFramesOwned(scene = 1) {
    const body = types.AvatarFramesOwnedRequest.encode(types.AvatarFramesOwnedRequest.create({
        scene: Number(scene) || 1,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.avatarframepb.AvatarFrameService', 'AvatarFramesOwned', body);
    return normalizeAvatarFrames(types.AvatarFramesOwnedReply.decode(replyBody));
}

async function getProfileModules() {
    // Keep these reads sequential. They are UI refresh calls, not automation, and
    // avoiding bursts is safer for newer protocol/risk-control behavior.
    const dog = await getDogInfo().catch(error => ({ error: error.message, dogs: [], foods: [] }));
    const skinsOwned = await getSkinsOwned().catch(error => ({ error: error.message }));
    const skinsEquipped = await getSkinsEquipped().catch(error => ({ error: error.message }));
    const avatarFrames = await getAvatarFramesOwned(1).catch(error => ({ error: error.message }));

    return {
        dog,
        skins: {
            owned: Array.isArray(skinsOwned) ? skinsOwned : [],
            equipped: Array.isArray(skinsEquipped) ? skinsEquipped : [],
            error: skinsOwned.error || skinsEquipped.error || '',
        },
        avatarFrames: {
            owned: Array.isArray(avatarFrames) ? avatarFrames : [],
            error: avatarFrames.error || '',
        },
        career: {
            status: 'pending_capture',
            message: 'Career protocol was not present in the current capture. Open the career page and capture again to implement it.',
        },
        goldenBug: {
            status: 'pending_capture',
            message: 'Golden bug protocol was not present in the current capture. Automated actions are disabled until it is captured.',
        },
    };
}

module.exports = {
    getDogInfo,
    getSkinsOwned,
    getSkinsEquipped,
    getAvatarFramesOwned,
    getProfileModules,
};
