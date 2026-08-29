import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export interface Land {
  id: number
  plantName?: string
  phaseName?: string
  seedImage?: string
  status: string
  matureInSec: number
  needWater?: boolean
  needWeed?: boolean
  needBug?: boolean
  [key: string]: any
}

export type FertilizerType = 'normal' | 'organic'

export const useFarmStore = defineStore('farm', () => {
  const lands = ref<Land[]>([])
  const seeds = ref<any[]>([])
  const summary = ref<any>({})
  const career = ref<any>(null)
  const socialEvents = ref<any[]>([])
  const loading = ref(false)
  let activeAccountId = ''
  let landsRequestVersion = 0

  function activateAccount(accountId: string) {
    const nextAccountId = String(accountId || '').trim()
    if (activeAccountId === nextAccountId)
      return
    activeAccountId = nextAccountId
    landsRequestVersion += 1
    lands.value = []
    seeds.value = []
    summary.value = {}
    career.value = null
    socialEvents.value = []
    loading.value = false
  }

  async function fetchLands(accountId: string) {
    const requestedAccountId = String(accountId || '').trim()
    if (!requestedAccountId)
      return
    const requestVersion = ++landsRequestVersion
    loading.value = true
    try {
      const { data } = await api.get('/api/lands', {
        headers: { 'x-account-id': requestedAccountId },
      })
      if (activeAccountId === requestedAccountId && requestVersion === landsRequestVersion && data?.ok) {
        lands.value = data.data.lands || []
        summary.value = data.data.summary || {}
        career.value = data.data.career || null
        socialEvents.value = data.data.socialEvents || []
      }
    }
    finally {
      if (activeAccountId === requestedAccountId && requestVersion === landsRequestVersion)
        loading.value = false
    }
  }

  async function fetchSeeds(accountId: string) {
    if (!accountId)
      return
    const { data } = await api.get('/api/seeds', {
      headers: { 'x-account-id': accountId },
    })
    if (data && data.ok)
      seeds.value = data.data || []
  }

  async function operate(accountId: string, opType: string) {
    if (!accountId)
      return
    await api.post('/api/farm/operate', { opType }, {
      headers: { 'x-account-id': accountId },
    })
    if (activeAccountId === accountId)
      await fetchLands(accountId)
  }

  async function fertilizeLand(accountId: string, landId: number, fertilizerType: FertilizerType) {
    if (!accountId || !landId)
      return null
    const { data } = await api.post('/api/farm/fertilize', { landId, fertilizerType }, {
      headers: { 'x-account-id': accountId },
      skipErrorToast: true,
    } as any)
    if (!data?.ok)
      throw new Error(data?.error || '施肥失败')
    if (activeAccountId !== accountId)
      return data.data
    if (data.data?.updatedLand) {
      const index = lands.value.findIndex(land => land.id === landId)
      if (index >= 0)
        lands.value[index] = data.data.updatedLand
    }
    else {
      // 施肥写请求已经成功，刷新失败不能再向用户报告写失败，否则可能诱导重复施肥。
      try {
        await fetchLands(accountId)
      }
      catch {
        // 下一轮自动刷新会补齐地块状态。
      }
    }
    return data.data
  }

  return { lands, summary, career, socialEvents, seeds, loading, activateAccount, fetchLands, fetchSeeds, operate, fertilizeLand }
})
