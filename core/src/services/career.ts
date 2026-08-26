const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, logWarn } = require('../utils/utils');

export interface CareerInfo {
    gid: number;
    harvest: number;
    steal: number;
    level: number;
    exp: number;
    name: string;
    avatarUrl: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<number, { expiresAt: number; value: CareerInfo }>();

export async function getCareerInfo(gid: unknown, force = false): Promise<CareerInfo> {
    const numericGid = toNum(gid);
    if (!numericGid) throw new Error('缺少有效的角色 GID');

    const cached = cache.get(numericGid);
    if (!force && cached && cached.expiresAt > Date.now()) return { ...cached.value };

    const body = types.CareerInfoGetRequest.encode(types.CareerInfoGetRequest.create({
        gid: toLong(numericGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.careerpb.CareerService', 'CareerInfoGet', body);
    const reply = types.CareerInfoGetReply.toObject(
        types.CareerInfoGetReply.decode(replyBody),
        { longs: Number, defaults: true },
    );
    const value: CareerInfo = {
        gid: toNum(reply.gid) || numericGid,
        harvest: toNum(reply.total_harvest_count ?? reply.totalHarvestCount),
        steal: toNum(reply.total_steal_count ?? reply.totalStealCount),
        level: toNum(reply.level),
        exp: toNum(reply.exp),
        name: String(reply.name || ''),
        avatarUrl: String(reply.avatar_url || reply.avatarUrl || ''),
    };
    cache.set(numericGid, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return { ...value };
}

export async function getCareerInfoOrNull(gid: unknown): Promise<CareerInfo | null> {
    try {
        return await getCareerInfo(gid);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn('生涯', `查询失败: ${message}`);
        return null;
    }
}

export function clearCareerInfoCache(gid?: unknown): void {
    const numericGid = toNum(gid);
    if (numericGid) cache.delete(numericGid);
    else cache.clear();
}
