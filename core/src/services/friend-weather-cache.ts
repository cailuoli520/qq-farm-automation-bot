import type { FriendVisitContext } from './friend-visit';
import { getItemById, getItemImageById } from '../config/gameConfig';

type DynamicRecord = Record<string, any>;

export const FRIEND_WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;

export interface FriendWeatherObservation {
    gid: string;
    host: { gid: string; name: string; avatarUrl: string; isSelf: false };
    weatherStatus: DynamicRecord;
    pet: { id: string; name: string; image: string } | null;
    inspectedAt: number;
}

const observations = new Map<string, FriendWeatherObservation>();

function asRecord(value: unknown): DynamicRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as DynamicRecord : {};
}

function petFromEnterReply(enterReply: DynamicRecord): FriendWeatherObservation['pet'] {
    const dog = asRecord(enterReply.brief_dog_info ?? enterReply.briefDogInfo);
    const id = String(dog.dog_id ?? dog.dogId ?? '').trim();
    if (!/^[1-9]\d*$/.test(id)) return null;
    const item = getItemById(id);
    return {
        id,
        name: String(item?.name || `宠物#${id}`),
        image: getItemImageById(id),
    };
}

export function recordFriendWeatherVisit(context: FriendVisitContext, inspectedAt = Date.now()): FriendWeatherObservation | null {
    const enterReply = asRecord(context.enterReply);
    const weatherStatus = asRecord(enterReply.weather_status ?? enterReply.weatherStatus);
    const basic = asRecord(enterReply.basic);
    const gid = String(basic.gid ?? context.friendGid ?? '').trim();
    if (!/^[1-9]\d*$/.test(gid)) return null;
    const observation: FriendWeatherObservation = {
        gid,
        host: {
            gid,
            name: String(basic.remark || basic.name || context.friendName || `GID:${gid}`),
            avatarUrl: String(basic.avatar_url ?? basic.avatarUrl ?? ''),
            isSelf: false,
        },
        weatherStatus,
        pet: petFromEnterReply(enterReply),
        inspectedAt,
    };
    observations.set(gid, observation);
    return observation;
}

export function getCachedFriendWeather(
    friendGid: unknown,
    now = Date.now(),
    ttlMs = FRIEND_WEATHER_CACHE_TTL_MS,
): FriendWeatherObservation | null {
    const gid = String(friendGid ?? '').trim();
    const cached = observations.get(gid);
    if (!cached) return null;
    if (now - cached.inspectedAt > Math.max(0, ttlMs)) {
        observations.delete(gid);
        return null;
    }
    return cached;
}

export function clearFriendWeatherCache(): void {
    observations.clear();
}
