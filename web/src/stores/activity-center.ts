import type {
  ActivityActionDto,
  ActivityCenterSnapshotDto,
  ActivityMutationKey,
  ActivityRecord,
  ActivityTabKey,
  QingMeiActivityDto,
  QixiActivityDto,
  QixiDewTargetsDto,
  RainPoetryActivityDto,
  RainWeatherCheckDto,
} from '@/features/activity-center/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fetchActivitySnapshot, fetchQixiDewTargetsRequest, fetchRainWeatherRequest, postActivityMutation } from '@/features/activity-center/api'
import {
  errorMessage,
  first,
  normalizeActivitySnapshot,
  normalizeItem,
  normalizeQixiDewTargets,
  normalizeRainWeatherCheck,
  record,
  records,
  text,
} from '@/features/activity-center/normalize'

export type * from '@/features/activity-center/types'
export const useActivityCenterStore = defineStore('activity-center', () => {
  const snapshot = ref<ActivityCenterSnapshotDto>(normalizeActivitySnapshot({}))
  const loading = ref(false)
  const error = ref('')
  const actionError = ref('')
  const notice = ref('')
  const loadedAccountId = ref('')
  const successfulAccountId = ref('')
  const serverClockOffset = ref(0)
  const requestVersion = ref(0)
  const pendingActions = ref<Record<ActivityMutationKey, boolean>>({
    claimPass: false,
    lightConstellation: false,
    claimSolar: false,
    exchange: false,
    qingMeiSeed: false,
    qingMeiStart: false,
    qingMeiContinue: false,
    qingMeiSettle: false,
    qixiBridge: false,
    qixiGift: false,
    qixiDew: false,
    rainExchange: false,
    rainCollect: false,
    rainThunderstorm: false,
    rainResearch: false,
  })
  const dewTargets = ref<QixiDewTargetsDto | null>(null)
  const dewTargetsLoading = ref(false)
  const dewTargetsError = ref('')
  const rainWeatherCheck = ref<RainWeatherCheckDto | null>(null)
  const rainWeatherLoading = ref(false)
  const rainWeatherError = ref('')
  let rainWeatherRequestVersion = 0
  let dewTargetsRequestVersion = 0
  let loadInFlight: { accountId: string, promise: Promise<boolean> } | null = null

  const season = computed(() => snapshot.value.season)
  const shop = computed(() => snapshot.value.shop)
  const solarTerms = computed(() => snapshot.value.solarTerms)
  const solar = solarTerms
  const constellation = computed(() => snapshot.value.constellation)
  const qingMei = computed(() => snapshot.value.qingMei)
  const qixi = computed(() => snapshot.value.qixi)
  const rainPoetry = computed(() => snapshot.value.rainPoetry)
  const actions = computed(() => snapshot.value.actions)
  const serverNow = computed(() => Date.now() + serverClockOffset.value)
  const tabBadges = computed<Partial<Record<ActivityTabKey, boolean>>>(() => ({
    travel: actions.value.claimPass.available,
    constellation: actions.value.lightConstellation.available,
    solar: actions.value.claimSolar.available,
    qingmei: !!qingMei.value && (!qingMei.value.dailySeed.claimed || qingMei.value.actions.continue.available || qingMei.value.actions.settle.available),
    qixi: !!qixi.value && (qixi.value.actions.bridge.available || qixi.value.actions.gift.available || qixi.value.actions.dew.available),
    rainTasks: !!rainPoetry.value && (rainPoetry.value.actions.exchange.available || rainPoetry.value.actions.collect.available || rainPoetry.value.actions.thunderstorm.available),
    rainResearch: !!rainPoetry.value?.actions.research.available,
  }))

  function reset() {
    requestVersion.value += 1
    dewTargetsRequestVersion += 1
    rainWeatherRequestVersion += 1
    loadInFlight = null
    snapshot.value = normalizeActivitySnapshot({})
    loading.value = false
    error.value = ''
    actionError.value = ''
    notice.value = ''
    loadedAccountId.value = ''
    successfulAccountId.value = ''
    serverClockOffset.value = 0
    dewTargets.value = null
    dewTargetsLoading.value = false
    dewTargetsError.value = ''
    rainWeatherCheck.value = null
    rainWeatherLoading.value = false
    rainWeatherError.value = ''
    pendingActions.value = { claimPass: false, lightConstellation: false, claimSolar: false, exchange: false, qingMeiSeed: false, qingMeiStart: false, qingMeiContinue: false, qingMeiSettle: false, qixiBridge: false, qixiGift: false, qixiDew: false, rainExchange: false, rainCollect: false, rainThunderstorm: false, rainResearch: false }
  }

  function isCurrent(version: number, accountId: string) {
    const storedAccountId = typeof localStorage === 'undefined' ? accountId : String(localStorage.getItem('current_account_id') || '')
    return requestVersion.value === version && storedAccountId === accountId
  }

  function disabledAction(action: ActivityActionDto): ActivityActionDto {
    return { ...action, enabled: false, available: false }
  }

  function disableQingMeiActions(activity: QingMeiActivityDto): QingMeiActivityDto {
    return {
      ...activity,
      actions: {
        claimSeed: disabledAction(activity.actions.claimSeed),
        start: disabledAction(activity.actions.start),
        continue: disabledAction(activity.actions.continue),
        settle: disabledAction(activity.actions.settle),
      },
    }
  }

  function disableQixiActions(activity: QixiActivityDto): QixiActivityDto {
    return {
      ...activity,
      actions: {
        bridge: disabledAction(activity.actions.bridge),
        gift: disabledAction(activity.actions.gift),
        dew: disabledAction(activity.actions.dew),
      },
    }
  }

  function disableRainActions(activity: RainPoetryActivityDto): RainPoetryActivityDto {
    return { ...activity, actions: { exchange: disabledAction(activity.actions.exchange), collect: disabledAction(activity.actions.collect), thunderstorm: disabledAction(activity.actions.thunderstorm), research: disabledAction(activity.actions.research) } }
  }

  function preserveQingMeiAfterUnknownMutation() {
    if (snapshot.value.qingMei) {
      snapshot.value = {
        ...snapshot.value,
        qingMei: disableQingMeiActions(snapshot.value.qingMei),
      }
    }
    return '青酿操作已提交，但最新状态暂未取回，请点击右上角刷新确认，不要重复操作'
  }

  function preserveQixiAfterUnknownMutation() {
    if (snapshot.value.qixi) {
      snapshot.value = {
        ...snapshot.value,
        qixi: disableQixiActions(snapshot.value.qixi),
        actions: {
          ...snapshot.value.actions,
          qixiBridge: disabledAction(snapshot.value.actions.qixiBridge),
          qixiGift: disabledAction(snapshot.value.actions.qixiGift),
          qixiDew: disabledAction(snapshot.value.actions.qixiDew),
        },
      }
    }
    return '鹊桥操作已提交，但最新状态暂未取回，请点击右上角刷新确认，不要重复操作'
  }

  function preserveRainAfterUnknownMutation() {
    if (snapshot.value.rainPoetry) {
      snapshot.value = {
        ...snapshot.value,
        rainPoetry: disableRainActions(snapshot.value.rainPoetry),
        actions: {
          ...snapshot.value.actions,
          rainExchange: disabledAction(snapshot.value.actions.rainExchange),
          rainCollect: disabledAction(snapshot.value.actions.rainCollect),
          rainThunderstorm: disabledAction(snapshot.value.actions.rainThunderstorm),
          rainResearch: disabledAction(snapshot.value.actions.rainResearch),
        },
      }
    }
    return '雨落成诗操作已提交，但最新状态暂未取回，请点击右上角刷新确认，不要重复操作'
  }

  function applySnapshot(value: unknown, clientStartedAt = Date.now(), preserveFailedActivity: 'qingMei' | 'qixi' | 'rainPoetry' | null = null) {
    const previousConstellation = snapshot.value.constellation
    const previousQingMei = snapshot.value.qingMei
    const previousQixi = snapshot.value.qixi
    const previousRain = snapshot.value.rainPoetry
    const normalized = normalizeActivitySnapshot(value)
    let warning = ''
    if (!normalized.constellation && normalized.errors.season && previousConstellation)
      normalized.constellation = previousConstellation
    if (!normalized.qingMei && normalized.errors.qingMei && previousQingMei) {
      normalized.qingMei = disableQingMeiActions(previousQingMei)
      if (preserveFailedActivity === 'qingMei')
        warning = '青酿操作已提交，但最新状态暂未取回，请点击右上角刷新确认，不要重复操作'
    }
    if (!normalized.qixi && normalized.errors.qixi && previousQixi && preserveFailedActivity === 'qixi') {
      normalized.qixi = disableQixiActions(previousQixi)
      normalized.actions.qixiBridge = disabledAction(normalized.actions.qixiBridge)
      normalized.actions.qixiGift = disabledAction(normalized.actions.qixiGift)
      normalized.actions.qixiDew = disabledAction(normalized.actions.qixiDew)
      warning = '鹊桥操作已提交，但最新状态暂未取回，请点击右上角刷新确认，不要重复操作'
    }
    if (!normalized.rainPoetry && normalized.errors.rainPoetry && previousRain && preserveFailedActivity === 'rainPoetry') {
      normalized.rainPoetry = disableRainActions(previousRain)
      normalized.actions.rainExchange = disabledAction(normalized.actions.rainExchange)
      normalized.actions.rainCollect = disabledAction(normalized.actions.rainCollect)
      normalized.actions.rainThunderstorm = disabledAction(normalized.actions.rainThunderstorm)
      normalized.actions.rainResearch = disabledAction(normalized.actions.rainResearch)
      warning = '雨落成诗操作已提交，但最新状态暂未取回，请点击右上角刷新确认，不要重复操作'
    }
    snapshot.value = normalized
    const serverTime = [normalized.season?.serverTime, normalized.shop?.serverTime, normalized.solarTerms?.serverTime, normalized.constellation?.serverTime, normalized.qingMei?.serverTime, normalized.qixi?.serverTime, normalized.rainPoetry?.serverTime]
      .find(value => value !== null && value !== undefined)
    if (serverTime !== undefined && serverTime !== null)
      serverClockOffset.value = serverTime - Math.round((clientStartedAt + Date.now()) / 2)
    return warning
  }

  async function load(accountId: string, force = false) {
    const requestedAccountId = String(accountId || '').trim()
    if (!requestedAccountId) {
      reset()
      error.value = '请先选择账号'
      return false
    }
    if (!force && loadedAccountId.value === requestedAccountId)
      return true
    if (loadInFlight?.accountId === requestedAccountId)
      return loadInFlight.promise

    const promise = (async () => {
      const version = ++requestVersion.value
      const clientStartedAt = Date.now()
      loading.value = true
      error.value = ''
      actionError.value = ''
      notice.value = ''
      if (loadedAccountId.value !== requestedAccountId) {
        snapshot.value = normalizeActivitySnapshot({})
        loadedAccountId.value = ''
        successfulAccountId.value = ''
        serverClockOffset.value = 0
      }

      try {
        const value = await fetchActivitySnapshot(requestedAccountId)
        if (!isCurrent(version, requestedAccountId))
          return false
        applySnapshot(value, clientStartedAt)
        loadedAccountId.value = requestedAccountId
        successfulAccountId.value = requestedAccountId
        return true
      }
      catch (loadError) {
        if (isCurrent(version, requestedAccountId)) {
          error.value = errorMessage(loadError)
          loadedAccountId.value = requestedAccountId
        }
        return false
      }
      finally {
        if (requestVersion.value === version)
          loading.value = false
      }
    })()
    loadInFlight = { accountId: requestedAccountId, promise }
    try {
      return await promise
    }
    finally {
      if (loadInFlight?.promise === promise)
        loadInFlight = null
    }
  }

  async function mutate(key: ActivityMutationKey, path: string, accountId: string, payload: ActivityRecord = {}) {
    const requestedAccountId = String(accountId || '').trim()
    if (!requestedAccountId || pendingActions.value[key])
      return false
    const version = requestVersion.value
    pendingActions.value[key] = true
    actionError.value = ''
    notice.value = ''
    try {
      const { result, responseData } = await postActivityMutation(path, requestedAccountId, payload)
      if (!isCurrent(version, requestedAccountId))
        return false
      const resultRecord = record(result)
      const mutationSnapshot = first(resultRecord.snapshot, resultRecord.activityCenter, resultRecord.activity_center)
      const mutationSnapshotError = text(resultRecord.snapshotError, resultRecord.snapshot_error)
      const mutationActivity = key.startsWith('qingMei') ? 'qingMei' : key.startsWith('qixi') ? 'qixi' : key.startsWith('rain') ? 'rainPoetry' : null
      let snapshotWarning = ''
      if (mutationSnapshot) {
        snapshotWarning = applySnapshot(mutationSnapshot, Date.now(), mutationActivity)
      }
      else if (mutationActivity && mutationSnapshotError) {
        snapshotWarning = mutationActivity === 'qingMei'
          ? preserveQingMeiAfterUnknownMutation()
          : mutationActivity === 'qixi' ? preserveQixiAfterUnknownMutation() : preserveRainAfterUnknownMutation()
      }
      else {
        await load(requestedAccountId, true)
      }
      const rewards = records(resultRecord.rewards).map(normalizeItem).filter(item => item.id || item.name)
      const rewardSummary = rewards.map(item => `${item.name || item.id}${item.count ? ` ×${item.count}` : ''}`).join('、')
      notice.value = text(resultRecord.message, record(responseData).message, rewardSummary ? `获得 ${rewardSummary}` : '操作成功')
      if (snapshotWarning)
        actionError.value = snapshotWarning
      return true
    }
    catch (mutationError) {
      if (isCurrent(version, requestedAccountId))
        actionError.value = errorMessage(mutationError, '活动操作失败')
      return false
    }
    finally {
      pendingActions.value[key] = false
    }
  }

  function claimPass(accountId: string) {
    return mutate('claimPass', '/pass/claim', accountId)
  }

  function lightConstellation(accountId: string) {
    return mutate('lightConstellation', '/constellation/light', accountId)
  }

  function claimSolarTerm(accountId: string, termId: string) {
    return mutate('claimSolar', `/solar-terms/${encodeURIComponent(termId)}/claim`, accountId)
  }

  function exchangeStarSandGoods(accountId: string, goodsId: string, count: number) {
    return mutate('exchange', '/shop/exchange', accountId, { goodsId, count })
  }

  function clearQixiDewTargets() {
    dewTargetsRequestVersion += 1
    dewTargets.value = null
    dewTargetsLoading.value = false
    dewTargetsError.value = ''
  }

  async function fetchQixiDewTargets(accountId: string, hostGid = '') {
    const requestedAccountId = String(accountId || '').trim()
    if (!requestedAccountId) {
      clearQixiDewTargets()
      dewTargetsError.value = '请先选择账号'
      return false
    }
    const version = ++dewTargetsRequestVersion
    dewTargetsLoading.value = true
    dewTargetsError.value = ''
    try {
      const value = await fetchQixiDewTargetsRequest(requestedAccountId, hostGid)
      if (version !== dewTargetsRequestVersion)
        return false
      dewTargets.value = normalizeQixiDewTargets(value)
      if (!dewTargets.value)
        dewTargetsError.value = '未能读取灵露候选地块'
      return !!dewTargets.value
    }
    catch (targetError) {
      if (version === dewTargetsRequestVersion) {
        dewTargets.value = null
        dewTargetsError.value = errorMessage(targetError, '加载灵露候选地块失败')
      }
      return false
    }
    finally {
      if (version === dewTargetsRequestVersion)
        dewTargetsLoading.value = false
    }
  }

  function claimQingMeiSeed(accountId: string) {
    return mutate('qingMeiSeed', '/qingmei/daily-seed/claim', accountId)
  }

  function startQingMeiBrew(accountId: string, ingredients: Array<{ uid: string, count: number }>) {
    return mutate('qingMeiStart', '/qingmei/brew/start', accountId, { ingredients })
  }

  function continueQingMeiBrew(accountId: string) {
    return mutate('qingMeiContinue', '/qingmei/brew/continue', accountId)
  }

  function settleQingMeiBrew(accountId: string) {
    return mutate('qingMeiSettle', '/qingmei/brew/settle', accountId)
  }

  function claimQixiBridgeRewards(accountId: string) {
    return mutate('qixiBridge', '/qixi/bridge/claim', accountId)
  }

  function giftQixiSachet(accountId: string, friendGid: string, messageTextId = 15) {
    return mutate('qixiGift', '/qixi/gift', accountId, { friendGid, messageTextId })
  }

  async function useQixiDew(accountId: string, hostGid: string, landId: string) {
    const succeeded = await mutate('qixiDew', '/qixi/dew/use', accountId, { hostGid, landId })
    if (succeeded)
      await fetchQixiDewTargets(accountId, hostGid)
    return succeeded
  }

  function clearRainWeather() {
    rainWeatherRequestVersion += 1
    rainWeatherCheck.value = null
    rainWeatherLoading.value = false
    rainWeatherError.value = ''
  }

  function clearActionFeedback() {
    actionError.value = ''
    notice.value = ''
  }

  async function checkRainWeather(
    accountId: string,
    friendGid: string,
    options: { cacheOnly?: boolean, forceRefresh?: boolean } = {},
  ) {
    const version = ++rainWeatherRequestVersion
    rainWeatherLoading.value = true
    rainWeatherError.value = ''
    rainWeatherCheck.value = null
    try {
      const result = normalizeRainWeatherCheck(await fetchRainWeatherRequest(accountId, friendGid, options))
      if (version !== rainWeatherRequestVersion)
        return false
      rainWeatherCheck.value = result
      if (!result && !options.cacheOnly)
        rainWeatherError.value = '未能读取好友天气'
      return !!result
    }
    catch (weatherError) {
      if (version === rainWeatherRequestVersion)
        rainWeatherError.value = errorMessage(weatherError, '检查好友天气失败')
      return false
    }
    finally {
      if (version === rainWeatherRequestVersion)
        rainWeatherLoading.value = false
    }
  }

  function exchangeRainBottle(accountId: string, goodsId: string) {
    return mutate('rainExchange', '/rain-poetry/exchange', accountId, { goodsId, count: 1 })
  }
  async function collectRainWeather(accountId: string, friendGid: string) {
    const succeeded = await mutate('rainCollect', '/rain-poetry/collect', accountId, { friendGid })
    if (succeeded)
      clearRainWeather()
    return succeeded
  }
  function useRainThunderstorm(accountId: string) {
    return mutate('rainThunderstorm', '/rain-poetry/thunderstorm/use', accountId)
  }

  function unlockRainResearch(accountId: string, nodeId: string) {
    return mutate('rainResearch', '/rain-poetry/research/unlock', accountId, { nodeId })
  }

  function lazyLoad(accountId: string) {
    return load(accountId, false)
  }

  function refresh(accountId: string) {
    return load(accountId, true)
  }

  return {
    snapshot,
    season,
    shop,
    solar,
    solarTerms,
    constellation,
    qingMei,
    qixi,
    rainPoetry,
    actions,
    tabBadges,
    loading,
    error,
    actionError,
    notice,
    loadedAccountId,
    successfulAccountId,
    serverClockOffset,
    serverNow,
    pendingActions,
    dewTargets,
    dewTargetsLoading,
    dewTargetsError,
    rainWeatherCheck,
    rainWeatherLoading,
    rainWeatherError,
    lazyLoad,
    refresh,
    claimPass,
    lightConstellation,
    claimSolarTerm,
    exchangeStarSandGoods,
    claimQingMeiSeed,
    startQingMeiBrew,
    continueQingMeiBrew,
    settleQingMeiBrew,
    claimQixiBridgeRewards,
    giftQixiSachet,
    fetchQixiDewTargets,
    clearQixiDewTargets,
    useQixiDew,
    checkRainWeather,
    clearRainWeather,
    clearActionFeedback,
    exchangeRainBottle,
    collectRainWeather,
    useRainThunderstorm,
    unlockRainResearch,
    reset,
  }
})
