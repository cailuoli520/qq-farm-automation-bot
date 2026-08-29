<script setup lang="ts">
/* eslint-disable style/max-statements-per-line */
import type { ActivityTab } from '@/components/activity/BottomNav.vue'
import type { ActivityEventKey } from '@/features/activity-center/types'
import type { ShopGoodsDto } from '@/stores/activity-center'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ActivityHeader from '@/components/activity/ActivityHeader.vue'
import ActivityShell from '@/components/activity/ActivityShell.vue'
import BottomNav from '@/components/activity/BottomNav.vue'
import ConstellationTab from '@/components/activity/ConstellationTab.vue'
import QingMeiTab from '@/components/activity/QingMeiTab.vue'
import QixiTab from '@/components/activity/QixiTab.vue'
import RainPoetryTab from '@/components/activity/RainPoetryTab.vue'
import SolarTermsTab from '@/components/activity/SolarTermsTab.vue'
import StarSandExchangeDialog from '@/components/activity/StarSandExchangeDialog.vue'
import StarSandShopTab from '@/components/activity/StarSandShopTab.vue'
import TravelPassTab from '@/components/activity/TravelPassTab.vue'
import { activityEvents, activityTabByKey } from '@/features/activity-center/registry'
import { useAccountStore } from '@/stores/account'
import { useActivityCenterStore } from '@/stores/activity-center'
import { useFriendStore } from '@/stores/friend'

const router = useRouter()
const accountStore = useAccountStore()
const activityStore = useActivityCenterStore()
const friendStore = useFriendStore()
const { currentAccountId } = storeToRefs(accountStore)
const { season, shop, solarTerms, constellation, qingMei, qixi, rainPoetry, actions, tabBadges, loading, error, actionError, notice, serverClockOffset, pendingActions, successfulAccountId, dewTargets, dewTargetsLoading, dewTargetsError, rainWeatherCheck, rainWeatherLoading, rainWeatherError } = storeToRefs(activityStore)
const { friends, loading: friendsLoading } = storeToRefs(friendStore)
const activeTab = ref<ActivityTab>('travel')
const activeEvent = ref<ActivityEventKey>('stellar')
const selectedShopGoods = ref<ShopGoodsDto | null>(null)
const clockNow = ref(Date.now())
let clockTimer: number | undefined

const currentData = computed(() => activeTab.value === 'shop' ? shop.value : activeTab.value === 'solar' ? solarTerms.value : activeTab.value === 'constellation' ? constellation.value : activeTab.value === 'qingmei' ? qingMei.value : activeTab.value === 'qixi' ? qixi.value : activeTab.value === 'rainTasks' || activeTab.value === 'rainResearch' ? rainPoetry.value : season.value)
const serverNow = computed(() => clockNow.value + serverClockOffset.value)
const pageTitle = computed(() => activeEvent.value === 'rainPoetry' ? (rainPoetry.value?.name || '雨落成诗') : activeTab.value === 'qingmei' ? (qingMei.value?.name || '青酿换万金') : activeTab.value === 'qixi' ? (qixi.value?.name || '鹊桥寄情') : currentData.value && 'title' in currentData.value ? currentData.value.title : (season.value?.title || '—'))
const activeTabDefinition = computed(() => activityTabByKey[activeTab.value])
const activityDataReady = computed(() => !!currentAccountId.value && successfulAccountId.value === String(currentAccountId.value))
function live(endTime: number | null | undefined) { return !endTime || endTime > serverNow.value }
function withinWindow(startTime: number | null | undefined, endTime: number | null | undefined) { return (!startTime || startTime <= serverNow.value) && live(endTime) }
function solarTermsLive() {
  if (!solarTerms.value)
    return false
  return !solarTerms.value.terms.length || solarTerms.value.terms.some(term => withinWindow(term.startTime, term.endTime))
}
function stellarTabLive(tab: ActivityTab) {
  if (tab === 'travel')
    return !!season.value && withinWindow(season.value.startTime, season.value.endTime)
  if (tab === 'constellation')
    return !!constellation.value && withinWindow(constellation.value.startTime, constellation.value.endTime)
  if (tab === 'shop')
    return !!shop.value && withinWindow(shop.value.startTime, shop.value.endTime)
  if (tab === 'solar')
    return solarTermsLive()
  return false
}
const visibleActivityEvents = computed(() => {
  if (!activityDataReady.value)
    return []
  return activityEvents.filter((event) => {
    if (event.key === 'stellar')
      return event.tabs.some(stellarTabLive)
    if (event.key === 'rainPoetry')
      return !!rainPoetry.value?.active && live(rainPoetry.value.endTime)
    if (event.key === 'qingmei')
      return !!qingMei.value && withinWindow(qingMei.value.startTime, qingMei.value.endTime)
    return !!qixi.value?.active && live(qixi.value.endTime)
  })
})
const visibleActivityTabs = computed(() => {
  const event = visibleActivityEvents.value.find(entry => entry.key === activeEvent.value)
  return event
    ? event.tabs.map(key => activityTabByKey[key]).filter((tab) => {
        if (event.key === 'stellar')
          return stellarTabLive(tab.key)
        return true
      })
    : []
})
const theme = computed(() => activeTabDefinition.value.theme)
const endTime = computed(() => {
  if (activeTab.value === 'shop')
    return shop.value?.endTime
  if (activeTab.value === 'constellation')
    return constellation.value?.endTime || season.value?.endTime
  if (activeTab.value === 'solar')
    return season.value?.endTime
  if (activeTab.value === 'qingmei')
    return qingMei.value?.endTime
  if (activeTab.value === 'qixi')
    return qixi.value?.endTime
  if (activeTab.value === 'rainTasks' || activeTab.value === 'rainResearch')
    return rainPoetry.value?.endTime
  return season.value?.endTime
})
const remaining = computed(() => {
  if (!endTime.value)
    return ''
  const diff = Math.max(0, endTime.value - serverNow.value)
  if (diff === 0)
    return '活动已结束'
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor(diff % 86400000 / 3600000)
  const minutes = Math.floor(diff % 3600000 / 60000)
  return days > 0 ? `剩余：${days}天${hours}小时` : `剩余：${hours}小时${minutes}分钟`
})
const balanceVisible = computed(() => activeTabDefinition.value.showBalance)
const brandImage = computed(() => activeTabDefinition.value.brandImage)

function accountId() { return String(currentAccountId.value || '') }
function load(force = false) { return force ? activityStore.refresh(accountId()) : activityStore.lazyLoad(accountId()) }
function goBack() { router.back() }
function claimPass() { activityStore.claimPass(accountId()) }
function lightConstellation() { activityStore.lightConstellation(accountId()) }
function claimSolar(termId: string) { activityStore.claimSolarTerm(accountId(), termId) }
function claimQingMeiSeed() { activityStore.claimQingMeiSeed(accountId()) }
function startQingMeiBrew(ingredients: Array<{ uid: string, count: number }>) { activityStore.startQingMeiBrew(accountId(), ingredients) }
function continueQingMeiBrew() { activityStore.continueQingMeiBrew(accountId()) }
function settleQingMeiBrew() { activityStore.settleQingMeiBrew(accountId()) }
function claimQixiBridge() { activityStore.claimQixiBridgeRewards(accountId()) }
function giftQixiSachet(friendGid: string) { activityStore.giftQixiSachet(accountId(), friendGid) }
function loadQixiDewTargets(hostGid: string) { activityStore.fetchQixiDewTargets(accountId(), hostGid) }
function useQixiDew(hostGid: string, landId: string) { activityStore.useQixiDew(accountId(), hostGid, landId) }
function refreshQixiFriends() { friendStore.fetchFriends(accountId(), true) }
function checkRainWeather(friendGid: string, options: { cacheOnly?: boolean, forceRefresh?: boolean } = {}) { activityStore.checkRainWeather(accountId(), friendGid, options) }
function exchangeRainBottle(goodsId: string) { activityStore.exchangeRainBottle(accountId(), goodsId) }
function collectRainWeather(friendGid: string) { activityStore.collectRainWeather(accountId(), friendGid) }
function useRainThunderstorm() { activityStore.useRainThunderstorm(accountId()) }
function unlockRainResearch(nodeId: string) { activityStore.unlockRainResearch(accountId(), nodeId) }
function selectShopGoods(goods: ShopGoodsDto) { selectedShopGoods.value = goods }
function closeExchangeDialog() {
  if (!pendingActions.value.exchange)
    selectedShopGoods.value = null
}
async function exchangeShopGoods(goodsId: string, count: number) {
  const succeeded = await activityStore.exchangeStarSandGoods(accountId(), goodsId, count)
  if (succeeded)
    selectedShopGoods.value = null
}

watch(currentAccountId, () => { selectedShopGoods.value = null; activityStore.clearQixiDewTargets(); activityStore.clearRainWeather(); load(true) }, { flush: 'post' })
watch(activeTab, async (tab) => {
  if (tab !== 'shop' && !pendingActions.value.exchange)
    selectedShopGoods.value = null
  if (tab === 'qixi' || tab === 'rainTasks') {
    await Promise.allSettled([
      tab === 'qixi' ? activityStore.fetchQixiDewTargets(accountId(), '') : Promise.resolve(),
      friendStore.fetchFriends(accountId()),
    ])
  }
  else {
    activityStore.clearQixiDewTargets()
    activityStore.clearRainWeather()
  }
})
watch(() => visibleActivityEvents.value.map(event => event.key).join(','), () => {
  if (!visibleActivityEvents.value.some(event => event.key === activeEvent.value))
    activeEvent.value = visibleActivityEvents.value[0]?.key || 'stellar'
}, { immediate: true })
watch(activeEvent, (eventKey) => {
  activityStore.clearActionFeedback()
  const event = visibleActivityEvents.value.find(entry => entry.key === eventKey)
  if (event && !event.tabs.includes(activeTab.value))
    activeTab.value = event.tabs[0] || 'travel'
})
watch(() => visibleActivityTabs.value.map(tab => tab.key).join(','), () => {
  if (!visibleActivityTabs.value.some(tab => tab.key === activeTab.value))
    activeTab.value = visibleActivityTabs.value[0]?.key || 'travel'
})
onMounted(() => { load(true); clockTimer = window.setInterval(() => clockNow.value = Date.now(), 1000) })
onUnmounted(() => {
  if (clockTimer)
    window.clearInterval(clockTimer)
})
</script>

<template>
  <ActivityShell :theme="theme">
    <div class="activity-center" :data-theme="theme">
      <ActivityHeader :title="pageTitle" :brand-image="brandImage" :remaining="remaining" :balance="balanceVisible ? (shop?.balanceKnown ? (shop.balance ?? '0') : '--') : undefined" :currency-image="shop?.currency.image" :currency-name="shop?.currency.name" :loading="loading" :show-refresh="activeTabDefinition.showRefresh" @back="goBack" @refresh="load(true)" />
      <div v-if="!currentAccountId" class="activity-state">
        <strong>请先选择账号</strong><span>活动数据按当前账号加载</span>
      </div>
      <div v-else-if="loading && !season && !shop && !solarTerms && !constellation && !qingMei && !qixi && !rainPoetry" class="activity-state">
        <div class="activity-spinner" /><strong>正在加载活动</strong>
      </div>
      <template v-else>
        <div v-if="error || actionError || notice" class="activity-message" :class="{ 'success': notice && !error && !actionError, 'with-switcher': visibleActivityEvents.length > 1 }" role="status">
          <span>{{ actionError || error || notice }}</span><button v-if="error" type="button" :disabled="loading" @click="load(true)">
            重试
          </button>
        </div>
        <nav v-if="visibleActivityEvents.length > 1" class="event-switcher" aria-label="当前活动">
          <button v-for="event in visibleActivityEvents" :key="event.key" type="button" :data-active="activeEvent === event.key || undefined" @click="activeEvent = event.key">
            {{ event.label }}
          </button>
        </nav>
        <div v-if="activityDataReady && !visibleActivityEvents.length" class="activity-state">
          <strong>当前暂无活动</strong><span>过期活动入口已自动隐藏</span>
        </div>
        <main class="activity-content">
          <TravelPassTab v-if="activeTab === 'travel'" :season="season" :enabled="actions.claimPass.enabled" :pending="pendingActions.claimPass" @claim="claimPass" />
          <ConstellationTab v-else-if="activeTab === 'constellation'" :constellation="constellation" :enabled="actions.lightConstellation.enabled" :pending="pendingActions.lightConstellation" @light="lightConstellation" />
          <StarSandShopTab v-else-if="activeTab === 'shop'" :shop="shop" :enabled="actions.exchange.enabled" :pending="pendingActions.exchange" @select="selectShopGoods" />
          <SolarTermsTab v-else-if="activeTab === 'solar'" :solar="solarTerms" :now="serverNow" :pending="pendingActions.claimSolar" @claim="claimSolar" />
          <QingMeiTab v-else-if="activeTab === 'qingmei'" :activity="qingMei" :pending-seed="pendingActions.qingMeiSeed" :pending-start="pendingActions.qingMeiStart" :pending-continue="pendingActions.qingMeiContinue" :pending-settle="pendingActions.qingMeiSettle" @claim-seed="claimQingMeiSeed" @start="startQingMeiBrew" @continue="continueQingMeiBrew" @settle="settleQingMeiBrew" />
          <RainPoetryTab
            v-else-if="activeTab === 'rainTasks' || activeTab === 'rainResearch'"
            :mode="activeTab === 'rainTasks' ? 'tasks' : 'research'"
            :activity="rainPoetry"
            :friends="friends"
            :friends-loading="friendsLoading"
            :weather-check="rainWeatherCheck"
            :weather-loading="rainWeatherLoading"
            :weather-error="rainWeatherError"
            :pending-exchange="pendingActions.rainExchange"
            :pending-collect="pendingActions.rainCollect"
            :pending-thunderstorm="pendingActions.rainThunderstorm"
            :pending-research="pendingActions.rainResearch"
            @check-weather="checkRainWeather"
            @refresh-friends="refreshQixiFriends"
            @exchange="exchangeRainBottle"
            @collect="collectRainWeather"
            @thunderstorm="useRainThunderstorm"
            @unlock="unlockRainResearch"
            @switch-mode="activeTab = $event === 'tasks' ? 'rainTasks' : 'rainResearch'"
          />
          <QixiTab
            v-else-if="activeTab === 'qixi'"
            :activity="qixi"
            :friends="friends"
            :friends-loading="friendsLoading"
            :dew-targets="dewTargets"
            :dew-targets-loading="dewTargetsLoading"
            :dew-targets-error="dewTargetsError"
            :pending-bridge="pendingActions.qixiBridge"
            :pending-gift="pendingActions.qixiGift"
            :pending-dew="pendingActions.qixiDew"
            @claim-bridge="claimQixiBridge"
            @gift="giftQixiSachet"
            @load-dew-targets="loadQixiDewTargets"
            @use-dew="useQixiDew"
            @refresh-friends="refreshQixiFriends"
          />
        </main>
      </template>
      <BottomNav v-if="visibleActivityTabs.length > 1" v-model="activeTab" :badges="tabBadges" :items="visibleActivityTabs" />
      <StarSandExchangeDialog
        :open="!!selectedShopGoods"
        :goods="selectedShopGoods"
        :shop="shop"
        :pending="pendingActions.exchange"
        @close="closeExchangeDialog"
        @confirm="exchangeShopGoods"
      />
    </div>
  </ActivityShell>
</template>

<style scoped>
.activity-center {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.activity-content {
  position: absolute;
  inset: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgba(172, 224, 246, 0.5) transparent;
}
.activity-message {
  position: absolute;
  z-index: 25;
  top: calc(91px + env(safe-area-inset-top));
  left: 12px;
  right: 12px;
  min-height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid rgba(255, 220, 142, 0.6);
  border-radius: 10px;
  color: #fff0c2;
  background: rgba(88, 51, 28, 0.86);
  font-size: 10px;
}
.activity-message.success {
  border-color: rgba(179, 242, 202, 0.65);
  color: #e5ffed;
  background: rgba(30, 91, 67, 0.83);
}
.activity-message.with-switcher {
  top: calc(122px + env(safe-area-inset-top));
}
.activity-message button {
  flex: none;
  padding: 3px 8px;
  border: 1px solid rgba(255, 255, 255, 0.42);
  border-radius: 8px;
  color: white;
  background: rgba(255, 255, 255, 0.12);
  cursor: pointer;
}
.event-switcher {
  position: absolute;
  z-index: 24;
  top: calc(84px + env(safe-area-inset-top));
  left: 50%;
  max-width: calc(100% - 28px);
  display: flex;
  gap: 4px;
  padding: 4px;
  overflow-x: auto;
  border: 1px solid rgba(255, 255, 255, 0.38);
  border-radius: 18px;
  background: rgba(16, 55, 75, 0.62);
  backdrop-filter: blur(10px);
  transform: translateX(-50%);
}
.event-switcher button {
  flex: none;
  padding: 5px 10px;
  border: 0;
  border-radius: 13px;
  color: rgba(255, 255, 255, 0.78);
  background: transparent;
  font-size: 10px;
  white-space: nowrap;
  cursor: pointer;
}
.event-switcher button[data-active] {
  color: #245044;
  background: #f5f3bd;
  box-shadow: 0 2px 7px rgba(0, 30, 45, 0.28);
}
.activity-center[data-theme='rain'] .event-switcher {
  gap: 2px;
  padding: 3px;
  border: 1px solid rgba(60, 60, 67, 0.08);
  border-radius: 10px;
  background: rgba(118, 118, 128, 0.14);
  box-shadow: none;
  backdrop-filter: saturate(180%) blur(20px);
}
.activity-center[data-theme='rain'] .event-switcher button {
  padding: 5px 12px;
  border-radius: 8px;
  color: #636366;
  font-weight: 600;
}
.activity-center[data-theme='rain'] .event-switcher button[data-active] {
  color: #1d1d1f;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.activity-state {
  position: absolute;
  z-index: 5;
  inset: 0 0 92px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #c9e7f7;
  text-align: center;
}
.activity-state strong {
  margin-top: 12px;
  font-size: 16px;
}
.activity-state span {
  margin-top: 4px;
  color: #9ec7dc;
  font-size: 11px;
}
.activity-spinner {
  width: 43px;
  height: 43px;
  border: 3px solid rgba(180, 232, 250, 0.25);
  border-top-color: #dff9ff;
  border-radius: 50%;
  animation: spin 0.85s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
