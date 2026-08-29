import type { ActivityRecord } from './types'
import api from '@/api'
import { responsePayload } from './normalize'

function requestOptions(accountId: string) {
  return {
    headers: { 'x-account-id': accountId },
    skipErrorToast: true,
  } as any
}

export async function fetchActivitySnapshot(accountId: string): Promise<unknown> {
  try {
    const response = await api.get('/api/activity-center/snapshot', requestOptions(accountId))
    return responsePayload(response.data)
  }
  catch (snapshotError: any) {
    if (snapshotError?.response?.status !== 404)
      throw snapshotError
    const [seasonResponse, shopResponse, solarResponse] = await Promise.all([
      api.get('/api/activity-center/season', requestOptions(accountId)),
      api.get('/api/activity-center/shop', requestOptions(accountId)),
      api.get('/api/activity-center/solar-terms', requestOptions(accountId)),
    ])
    return {
      season: responsePayload(seasonResponse.data),
      shop: responsePayload(shopResponse.data),
      solarTerms: responsePayload(solarResponse.data),
    }
  }
}

export async function postActivityMutation(path: string, accountId: string, payload: ActivityRecord) {
  const response = await api.post(`/api/activity-center${path}`, payload, {
    ...requestOptions(accountId),
    timeout: 155000,
  })
  return {
    result: responsePayload(response.data),
    responseData: response.data,
  }
}

export async function fetchQixiDewTargetsRequest(accountId: string, hostGid = ''): Promise<unknown> {
  const response = await api.get('/api/activity-center/qixi/dew/targets', {
    ...requestOptions(accountId),
    params: hostGid ? { hostGid } : {},
  })
  return responsePayload(response.data)
}

export async function fetchRainWeatherRequest(
  accountId: string,
  friendGid: string,
  options: { cacheOnly?: boolean, forceRefresh?: boolean } = {},
): Promise<unknown> {
  const response = await api.get('/api/activity-center/rain-poetry/weather', {
    ...requestOptions(accountId),
    params: {
      friendGid,
      ...(options.cacheOnly ? { cacheOnly: 'true' } : {}),
      ...(options.forceRefresh ? { forceRefresh: 'true' } : {}),
    },
  })
  return responsePayload(response.data)
}
