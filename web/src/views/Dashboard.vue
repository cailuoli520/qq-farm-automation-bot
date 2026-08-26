<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { buildEventOptions, buildModuleOptions, getEventLabel, resolveLogLevel } from '@/features/logs/filter-options'
import { useAccountStore } from '@/stores/account'
import { useBagStore } from '@/stores/bag'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const statusStore = useStatusStore()
const accountStore = useAccountStore()
const bagStore = useBagStore()
const toastStore = useToastStore()
const {
  status,
  diamondBalance,
  logs: statusLogs,
  accountLogs: statusAccountLogs,
  realtimeConnected,
  observedLogModules,
  observedLogEvents,
  observedLogEventModules,
  observedDevLogModules,
  observedDevLogEvents,
  observedDevLogEventModules,
} = storeToRefs(statusStore)
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { dashboardItems } = storeToRefs(bagStore)
const logContainer = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const lastBagFetchAt = ref(0)
const clearingLogs = ref(false)
const activeLogView = ref<'runtime' | 'account'>('runtime')
const accountLogKeyword = ref('')

const filter = reactive({
  module: '',
  event: '',
  keywordInput: '',
  keywordApplied: '',
  level: '',
  // 开发日志（调试/探测类）：默认关闭（不显示），调试时打开
  showDev: false,
})

const runtimeLogs = computed(() => (statusLogs.value || [])
  .filter((log: any) => (!(log.meta && log.meta.dev) || filter.showDev))
  .sort((a: any, b: any) => Number(a.ts || 0) - Number(b.ts || 0)))

const accountLogs = computed(() => {
  const terms = accountLogKeyword.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return (statusAccountLogs.value || [])
    .filter((log: any) => String(log?.accountId || log?.id || '') === String(currentAccountId.value || ''))
    .filter((log: any) => {
      if (!terms.length)
        return true
      const text = `${log?.action || ''} ${log?.accountName || ''} ${log?.msg || ''} ${log?.reason || ''}`.toLowerCase()
      return terms.every(term => text.includes(term))
    })
    .map((log: any) => ({
      ...log,
      ts: Number(log.ts) || Date.parse(String(log.time || '')) || 0,
    }))
    .sort((a: any, b: any) => a.ts - b.ts)
})

const visibleLogs = computed(() => activeLogView.value === 'runtime' ? runtimeLogs.value : accountLogs.value)

const hasActiveLogFilter = computed(() =>
  !!(filter.module || filter.event || filter.keywordApplied || filter.level),
)

const visibleObservedLogModules = computed(() => filter.showDev
  ? [...new Set([...observedLogModules.value, ...observedDevLogModules.value])]
  : observedLogModules.value)
const visibleObservedLogEvents = computed(() => filter.showDev
  ? [...new Set([...observedLogEvents.value, ...observedDevLogEvents.value])]
  : observedLogEvents.value)
const visibleObservedLogEventModules = computed(() => {
  if (!filter.showDev)
    return observedLogEventModules.value
  const merged: Record<string, string[]> = {}
  for (const source of [observedLogEventModules.value, observedDevLogEventModules.value]) {
    for (const [event, eventModules] of Object.entries(source))
      merged[event] = [...new Set([...(merged[event] || []), ...eventModules])]
  }
  return merged
})

const modules = computed(() => buildModuleOptions(visibleObservedLogModules.value))
const events = computed(() => buildEventOptions(
  visibleObservedLogEvents.value,
  filter.module,
  visibleObservedLogEventModules.value,
))
const levels = [
  { label: '所有等级', value: '' },
  { label: '普通', value: 'info' },
  { label: '警告', value: 'warn' },
  { label: '错误', value: 'error' },
]

const displayName = computed(() => {
  const account = accountStore.currentAccount

  // Try to use nickname from status (game server)
  const gameName = status.value?.status?.name
  if (gameName) {
    // 如果有备注，显示为“昵称（备注）”
    if (account?.name) {
      return `${gameName} (${account.name})`
    }
    return gameName
  }

  // Check login status
  if (!status.value?.connection?.connected) {
    if (account) {
      // 如果有备注和昵称，显示为“昵称（备注）”
      if (account.name && account.nick) {
        return `${account.nick} (${account.name})`
      }
      return account.name || account.nick || '未登录'
    }
    return '未登录'
  }

  // Fallback to account name (usually ID) or '未命名'
  if (account) {
    // 如果有备注和昵称，显示为“昵称（备注）”
    if (account.name && account.nick) {
      return `${account.nick} (${account.name})`
    }
    return account.name || account.nick || '未命名'
  }
  return '未命名'
})

// Exp Rate & Time to Level
const expRate = computed(() => {
  const gain = status.value?.sessionExpGained || 0
  const uptime = status.value?.uptime || 0
  if (!uptime)
    return '0/时'
  const hours = uptime / 3600
  const rate = hours > 0 ? (gain / hours) : 0
  return `${Math.floor(rate)}/时`
})

const timeToLevel = computed(() => {
  const gain = status.value?.sessionExpGained || 0
  const uptime = status.value?.uptime || 0
  const current = status.value?.levelProgress?.current || 0
  const needed = status.value?.levelProgress?.needed || 0

  if (!needed || !uptime || gain <= 0)
    return ''

  const hours = uptime / 3600
  const ratePerHour = hours > 0 ? (gain / hours) : 0
  if (ratePerHour <= 0)
    return ''

  const expNeeded = needed - current
  const minsToLevel = expNeeded / (ratePerHour / 60)

  if (minsToLevel < 60)
    return `约 ${Math.ceil(minsToLevel)} 分钟后升级`
  return `约 ${(minsToLevel / 60).toFixed(1)} 小时后升级`
})

// Fertilizer & Collection
const fertilizerNormal = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 1011))
const fertilizerOrganic = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 1012))
const collectionNormal = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 3001))
const collectionRare = computed(() => dashboardItems.value.find((i: any) => Number(i.id) === 3002))

function formatBucketTime(item: any) {
  if (!item)
    return '0.0h'
  if (item.hoursText)
    return item.hoursText.replace('小时', 'h')
  const count = Number(item.count || 0)
  return `${(count / 3600).toFixed(1)}h`
}

// Next Check Countdown
const nextFarmCheck = ref('--:--:--')
const nextHelpCheck = ref('--:--:--')
const nextStealCheck = ref('--:--:--')
const localUptime = ref(0)
let localNextFarmRemainSec = 0
let localNextHelpRemainSec = 0
let localNextStealRemainSec = 0

function updateCountdowns() {
  // Update uptime
  if (!status.value?.connection?.connected) {
    nextFarmCheck.value = '账号未登录'
    nextHelpCheck.value = '账号未登录'
    nextStealCheck.value = '账号未登录'
  }
  else {
    localUptime.value++
    if (localNextFarmRemainSec > 0) {
      localNextFarmRemainSec--
      nextFarmCheck.value = formatDuration(localNextFarmRemainSec)
    }
    else {
      nextFarmCheck.value = '巡查中...'
    }

    if (localNextHelpRemainSec > 0) {
      localNextHelpRemainSec--
      nextHelpCheck.value = formatDuration(localNextHelpRemainSec)
    }
    else {
      nextHelpCheck.value = '巡查中...'
    }

    if (localNextStealRemainSec > 0) {
      localNextStealRemainSec--
      nextStealCheck.value = formatDuration(localNextStealRemainSec)
    }
    else {
      nextStealCheck.value = '巡查中...'
    }
  }
}

watch(status, (newVal) => {
  if (newVal?.nextChecks) {
    // Only update local counters if they are significantly different or 0
    // Actually, we should sync from server periodically.
    // Here we just take server value when it comes.
    localNextFarmRemainSec = newVal.nextChecks.farmRemainSec || 0
    localNextHelpRemainSec = newVal.nextChecks.helpRemainSec || 0
    localNextStealRemainSec = newVal.nextChecks.stealRemainSec || 0
    updateCountdowns() // Update immediately
  }
  if (newVal?.uptime !== undefined) {
    localUptime.value = newVal.uptime
  }
}, { deep: true })

function formatDuration(seconds: number) {
  if (seconds <= 0)
    return '00:00:00'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  const pad = (n: number) => n.toString().padStart(2, '0')

  if (d > 0)
    return `${d}天 ${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

function getLogTagClass(tag: string, log: any) {
  const level = resolveLogLevel(log)
  if (level === 'error')
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  if (level === 'warn')
    return 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
  if (tag === '系统')
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
}

function getLogMsgClass(log: any) {
  if (resolveLogLevel(log) === 'error')
    return 'text-red-600 dark:text-red-400'
  if (resolveLogLevel(log) === 'warn')
    return 'text-orange-600 dark:text-orange-400'
  return 'text-gray-700 dark:text-gray-300'
}

const ACCOUNT_ACTION_LABELS: Record<string, string> = {
  add: '添加账号',
  update: '更新账号',
  start: '启动账号',
  stop: '停止账号',
  delete: '删除账号',
  start_failed: '启动失败',
  unexpected_exit: '异常退出',
  kickout_stop: '被踢下线',
  reauth_required: '需要重新认证',
  offline_delete: '离线自动删除',
  auto_relogin: '自动重登',
}

function getAccountActionLabel(action: unknown) {
  const key = String(action || '')
  return ACCOUNT_ACTION_LABELS[key] || key || '账号动态'
}

function formatLogTime(timeStr: string) {
  // 2024/5/20 12:34:56 -> 12:34:56
  if (!timeStr)
    return ''
  const parts = timeStr.split(' ')
  return parts.length > 1 ? parts[1] : timeStr
}

const OP_META: Record<string, { label: string, icon: string, color: string }> = {
  harvest: { label: '收获', icon: 'i-carbon-crop-growth', color: 'text-green-500' },
  water: { label: '浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-400' },
  weed: { label: '除草', icon: 'i-carbon-cut-out', color: 'text-yellow-500' },
  bug: { label: '除虫', icon: 'i-carbon-warning-alt', color: 'text-red-400' },
  fertilize: { label: '施肥', icon: 'i-carbon-chemistry', color: 'text-emerald-500' },
  plant: { label: '种植', icon: 'i-carbon-tree', color: 'text-lime-500' },
  steal: { label: '偷菜', icon: 'i-carbon-run', color: 'text-orange-500' },
  helpWater: { label: '帮浇水', icon: 'i-carbon-rain-drop', color: 'text-blue-300' },
  helpWeed: { label: '帮除草', icon: 'i-carbon-cut-out', color: 'text-yellow-400' },
  helpBug: { label: '帮除虫', icon: 'i-carbon-warning-alt', color: 'text-red-300' },
  taskClaim: { label: '任务', icon: 'i-carbon-task-complete', color: 'text-indigo-500' },
  sell: { label: '出售', icon: 'i-carbon-shopping-cart', color: 'text-pink-500' },
}

const filteredOperations = computed(() => {
  const ops = status.value?.operations || {}
  const result: Record<string, number> = {}
  for (const key of Object.keys(ops)) {
    if (key !== 'upgrade' && key !== 'levelUp') {
      result[key] = ops[key]
    }
  }
  return result
})

function getOpName(key: string | number) {
  return OP_META[String(key)]?.label || String(key)
}

function getOpIcon(key: string | number) {
  return OP_META[String(key)]?.icon || 'i-carbon-circle-dash'
}

function getOpColor(key: string | number) {
  return OP_META[String(key)]?.color || 'text-gray-400'
}

function getExpPercent(p: any) {
  if (!p || !p.needed)
    return 0
  return Math.min(100, Math.max(0, (p.current / p.needed) * 100))
}

async function refreshBag(force = false) {
  if (!currentAccountId.value)
    return
  if (!currentAccount.value?.running)
    return
  if (!status.value?.connection?.connected)
    return

  const now = Date.now()
  if (!force && now - lastBagFetchAt.value < 2500)
    return
  lastBagFetchAt.value = now
  await bagStore.fetchBag(currentAccountId.value)
}

function formatAssetAmount(value: unknown) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)).toLocaleString('zh-CN') : '0'
}

async function refreshDiamond() {
  if (!currentAccountId.value || !currentAccount.value?.running)
    return
  if (!status.value?.connection?.connected)
    return
  await statusStore.fetchDiamond(currentAccountId.value)
}

async function refresh(forceReloadLogs = false) {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return

    // 首次加载、断线兜底时走 HTTP；连接正常时优先走 WS 实时推送
    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
      await statusStore.fetchAccountLogs(currentAccountId.value)
    }

    if (forceReloadLogs || hasActiveLogFilter.value || !realtimeConnected.value) {
      await statusStore.fetchLogs(currentAccountId.value, {
        module: filter.module || undefined,
        event: filter.event || undefined,
        keyword: filter.keywordApplied || undefined,
        level: filter.level || undefined,
        hideDev: !filter.showDev,
      })
    }

    // 仅在账号已运行且连接就绪后拉背包，避免启动阶段触发500
    await refreshBag()
  }
}

async function applyRuntimeLogMode(forceReload = false) {
  statusStore.invalidateLogRequests()
  statusStore.setRealtimeLogsEnabled(false)
  if (forceReload || hasActiveLogFilter.value || !realtimeConnected.value)
    await refresh(true)
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
}

function onLogSearchTrigger() {
  filter.keywordApplied = filter.keywordInput.trim()
  void applyRuntimeLogMode(true)
}

function onLogFilterChange() {
  void applyRuntimeLogMode(true)
}

function onModuleFilterChange() {
  const availableEvents = new Set(events.value.map(option => option.value))
  if (filter.event && !availableEvents.has(filter.event))
    filter.event = ''
  onLogFilterChange()
}

async function onDevLogChange() {
  if (hasActiveLogFilter.value) {
    await applyRuntimeLogMode(true)
    return
  }
  statusStore.invalidateLogRequests()
  await refresh(true)
}

function resetLogFilters() {
  filter.module = ''
  filter.event = ''
  filter.keywordInput = ''
  filter.keywordApplied = ''
  filter.level = ''
  filter.showDev = false
  void applyRuntimeLogMode()
}

watch(currentAccountId, async () => {
  diamondBalance.value = 0
  statusStore.connectRealtime(currentAccountId.value)
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
  await Promise.all([
    refresh(hasActiveLogFilter.value || !realtimeConnected.value),
    statusStore.fetchAccountLogs(currentAccountId.value),
  ])
  await refreshDiamond()
  scrollToBottom()
})

watch(() => status.value?.connection?.connected, (connected) => {
  if (connected) {
    refreshBag(true)
    refreshDiamond()
  }
})

watch(() => JSON.stringify(status.value?.operations || {}), (next, prev) => {
  if (!realtimeConnected.value || next === prev)
    return
  refreshBag()
})

function onLogScroll(e: Event) {
  const el = e.target as HTMLElement
  if (!el)
    return
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50
  autoScroll.value = isNearBottom
}

async function clearLogs() {
  if (!currentAccountId.value)
    return
  clearingLogs.value = true
  try {
    const { data } = await api.delete('/api/logs')
    if (data?.ok) {
      toastStore.success('日志已清空')
      await applyRuntimeLogMode()
    }
    else {
      toastStore.error(`清空失败: ${data?.error || '未知错误'}`)
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '请求失败'
    toastStore.error(`清空失败: ${msg}`)
  }
  finally {
    clearingLogs.value = false
  }
}

// Auto scroll logs
watch(visibleLogs, () => {
  nextTick(() => {
    if (logContainer.value && autoScroll.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  })
}, { deep: true })

function scrollToBottom() {
  nextTick(() => {
    if (logContainer.value) {
      logContainer.value.scrollTop = logContainer.value.scrollHeight
    }
  })
}

onMounted(async () => {
  statusStore.connectRealtime(currentAccountId.value)
  statusStore.setRealtimeLogsEnabled(!hasActiveLogFilter.value)
  await Promise.all([
    refresh(hasActiveLogFilter.value || !realtimeConnected.value),
    statusStore.fetchAccountLogs(currentAccountId.value),
  ])
  await refreshDiamond()
  scrollToBottom()
})

// Auto refresh fallback every 10s (WS 断开或筛选条件启用时会回退 HTTP)
useIntervalFn(refresh, 10000)
// Countdown timer (every 1s)
useIntervalFn(updateCountdowns, 1000)
</script>

<template>
  <div class="flex flex-col gap-6 pt-6">
    <!-- Status Cards -->
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3 sm:grid-cols-2">
      <!-- Account & Exp -->
      <div class="flex flex-col rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-2 flex items-start justify-between">
          <div class="flex items-center gap-1.5 text-sm text-gray-500">
            <img
              v-if="currentAccount?.platform === 'wx'"
              :src="`/api/accounts/${currentAccount?.id}/avatar?v=${encodeURIComponent(currentAccount?.avatar || '')}`"
              class="h-5 w-5 rounded-full object-cover"
              @error="(e) => (e.target as HTMLImageElement).style.display = 'none'"
            >
            <div v-else class="i-fas-user-circle" />
            账号
          </div>
          <div class="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
            Lv.{{ status?.status?.level || 0 }}
          </div>
        </div>
        <div class="mb-1 truncate text-xl font-bold" :title="displayName">
          {{ displayName }}
        </div>

        <!-- Level Progress -->
        <div class="mt-auto">
          <div class="mb-1 flex justify-between text-xs text-gray-500">
            <div class="flex items-center gap-1">
              <div class="i-fas-bolt text-blue-400" />
              <span>EXP</span>
            </div>
            <span>{{ status?.levelProgress?.current || 0 }} / {{ status?.levelProgress?.needed || '?' }}</span>
          </div>
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700">
            <div
              class="h-full rounded-full bg-blue-500 transition-all duration-500"
              :style="{ width: `${getExpPercent(status?.levelProgress)}%` }"
            />
          </div>
          <div class="mt-2 flex justify-between text-xs text-gray-400">
            <span>效率: {{ expRate }}</span>
            <span>{{ timeToLevel }}</span>
          </div>
        </div>
      </div>

      <!-- Assets & Status -->
      <div class="flex flex-col justify-between rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="grid grid-cols-2 gap-x-4 gap-y-3">
          <div class="border-b border-r border-gray-100 pb-3 pr-3 dark:border-gray-700">
            <div class="flex items-center gap-1.5 text-xs text-gray-500">
              <div class="i-fas-coins text-yellow-500" />
              金币
            </div>
            <div class="text-2xl text-yellow-600 font-bold tabular-nums dark:text-yellow-500">
              {{ formatAssetAmount(status?.status?.gold) }}
            </div>
            <div
              v-if="(status?.sessionGoldGained || 0) !== 0"
              class="text-[10px]"
              :class="(status?.sessionGoldGained || 0) > 0 ? 'text-green-500' : 'text-red-500'"
            >
              {{ (status?.sessionGoldGained || 0) > 0 ? '+' : '' }}{{ status?.sessionGoldGained || 0 }}
            </div>
          </div>
          <div class="border-b border-gray-100 pb-3 pl-3 text-right dark:border-gray-700">
            <div class="flex items-center justify-end gap-1.5 text-xs text-gray-500">
              <div class="i-fas-ticket-alt text-emerald-400" />
              点券
            </div>
            <div class="text-2xl text-emerald-500 font-bold tabular-nums dark:text-emerald-400">
              {{ formatAssetAmount(status?.status?.coupon) }}
            </div>
            <div
              v-if="(status?.sessionCouponGained || 0) !== 0"
              class="text-[10px]"
              :class="(status?.sessionCouponGained || 0) > 0 ? 'text-green-500' : 'text-red-500'"
            >
              {{ (status?.sessionCouponGained || 0) > 0 ? '+' : '' }}{{ status?.sessionCouponGained || 0 }}
            </div>
          </div>
          <div class="border-r border-gray-100 pr-3 pt-3 dark:border-gray-700">
            <div class="flex items-center gap-1.5 text-xs text-gray-500">
              <div class="i-fas-seedling text-amber-500" />
              金豆豆
            </div>
            <div class="text-2xl text-amber-500 font-bold tabular-nums dark:text-amber-400">
              {{ formatAssetAmount(status?.status?.goldBean) }}
            </div>
          </div>
          <div class="pl-3 pt-3 text-right">
            <div class="flex items-center justify-end gap-1.5 text-xs text-gray-500">
              <div class="i-fas-gem text-cyan-500" />
              钻石
            </div>
            <div class="text-2xl text-cyan-600 font-bold tabular-nums dark:text-cyan-400">
              {{ formatAssetAmount(diamondBalance) }}
            </div>
          </div>
        </div>
        <div class="mt-4 border-t border-gray-100 pt-3 dark:border-gray-700">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <div class="h-2.5 w-2.5 rounded-full" :class="status?.connection?.connected ? 'bg-green-500' : 'bg-red-500'" />
              <span class="text-xs font-bold">{{ status?.connection?.connected ? '在线' : '离线' }}</span>
            </div>
            <div class="flex items-center gap-1.5 text-xs text-gray-400">
              <div class="i-fas-clock text-purple-400" />
              {{ formatDuration(localUptime) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Items (Fertilizer & Collection) -->
      <div class="flex flex-col justify-between rounded-lg bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-2 flex items-center gap-1.5 text-sm text-gray-500">
          <div class="i-fas-flask text-emerald-400" />
          化肥容器
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-flask text-emerald-400" />
              普通
            </div>
            <div class="font-bold">
              {{ formatBucketTime(fertilizerNormal) }}
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-vial text-emerald-400" />
              有机
            </div>
            <div class="font-bold">
              {{ formatBucketTime(fertilizerOrganic) }}
            </div>
          </div>
        </div>
        <div class="my-2 border-t border-gray-100 dark:border-gray-700" />
        <div class="mb-1 flex items-center gap-1.5 text-sm text-gray-500">
          <div class="i-fas-star text-emerald-400" />
          收藏点
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-bookmark text-emerald-400" />
              普通
            </div>
            <div class="font-bold">
              {{ collectionNormal?.count || 0 }}
            </div>
          </div>
          <div>
            <div class="flex items-center gap-1 text-xs text-gray-400">
              <div class="i-fas-gem text-emerald-400" />
              典藏
            </div>
            <div class="font-bold">
              {{ collectionRare?.count || 0 }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Content Flex -->
    <div class="flex flex-1 flex-col items-stretch gap-6 md:flex-row">
      <!-- Logs (Left Column) -->
      <div class="flex flex-1 flex-col gap-6 md:w-3/4">
        <!-- Logs -->
        <div class="flex flex-1 flex-col rounded-lg bg-white p-6 shadow md:overflow-hidden dark:bg-gray-800">
          <div class="mb-4 flex flex-col gap-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 class="flex items-center gap-2 text-lg font-medium">
                <div class="i-carbon-document" />
                <span>日志</span>
              </h3>
              <div class="inline-flex rounded-lg bg-gray-100 p-1 text-sm dark:bg-gray-700/60">
                <button
                  type="button"
                  class="rounded-md px-3 py-1.5 transition-colors"
                  :class="activeLogView === 'runtime' ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800 dark:text-blue-400' : 'text-gray-500 dark:text-gray-300'"
                  @click="activeLogView = 'runtime'"
                >
                  运行日志
                </button>
                <button
                  type="button"
                  class="rounded-md px-3 py-1.5 transition-colors"
                  :class="activeLogView === 'account' ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-800 dark:text-blue-400' : 'text-gray-500 dark:text-gray-300'"
                  @click="activeLogView = 'account'"
                >
                  账号动态
                </button>
              </div>
            </div>

            <div v-if="activeLogView === 'runtime'" class="flex flex-wrap items-center justify-end gap-2 text-sm">
              <BaseSelect
                v-model="filter.module"
                :options="modules"
                class="w-32"
                @change="onModuleFilterChange"
              />

              <BaseSelect
                v-model="filter.event"
                :options="events"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseSelect
                v-model="filter.level"
                :options="levels"
                class="w-32"
                @change="onLogFilterChange"
              />

              <BaseInput
                v-model="filter.keywordInput"
                placeholder="关键词..."
                class="w-32"
                clearable
                @keyup.enter="onLogSearchTrigger"
                @clear="onLogSearchTrigger"
              />

              <BaseSwitch
                v-model="filter.showDev"
                label="开发日志"
                @change="onDevLogChange"
              />

              <BaseButton
                variant="primary"
                size="sm"
                @click="onLogSearchTrigger"
              >
                <div class="i-carbon-search" />
              </BaseButton>

              <BaseButton
                v-if="hasActiveLogFilter || filter.showDev || filter.keywordInput"
                variant="secondary"
                size="sm"
                title="重置筛选"
                @click="resetLogFilters"
              >
                <div class="i-carbon-filter-reset" />
              </BaseButton>

              <BaseButton
                variant="secondary"
                size="sm"
                :loading="clearingLogs"
                @click="clearLogs"
              >
                <div class="i-carbon-trash-can" />
              </BaseButton>
            </div>
            <div v-else class="flex flex-wrap items-center justify-end gap-2 text-sm">
              <BaseInput
                v-model="accountLogKeyword"
                placeholder="搜索账号动态..."
                class="w-56"
                clearable
              />
              <span class="text-xs text-gray-400">仅显示当前账号，共 {{ accountLogs.length }} 条</span>
            </div>
          </div>

          <div ref="logContainer" class="max-h-[50vh] min-h-0 flex-1 overflow-y-auto rounded bg-gray-50 p-4 text-sm leading-relaxed font-mono dark:bg-gray-900" @scroll="onLogScroll">
            <div v-if="!visibleLogs.length" class="py-8 text-center text-gray-400">
              {{ activeLogView === 'runtime' ? '暂无运行日志' : '暂无账号动态' }}
            </div>
            <template v-if="activeLogView === 'runtime'">
              <div v-for="log in runtimeLogs" :key="`${log.ts}:${log.msg}:${log.meta?.event || ''}`" class="mb-1 break-all">
                <span class="mr-2 select-none text-gray-400">[{{ formatLogTime(log.time) }}]</span>
                <span class="mr-2 rounded px-1.5 py-0.5 text-xs font-bold" :class="getLogTagClass(log.tag, log)">{{ log.tag }}</span>
                <span v-if="log.meta?.event" class="mr-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-500 dark:bg-blue-900/20 dark:text-blue-400">{{ getEventLabel(log.meta.event) }}</span>
                <span :class="getLogMsgClass(log)">{{ log.msg }}</span>
              </div>
            </template>
            <template v-else>
              <div v-for="log in accountLogs" :key="`${log.ts}:${log.action}:${log.msg}`" class="mb-2 break-all">
                <span class="mr-2 select-none text-gray-400">[{{ formatLogTime(log.time) }}]</span>
                <span class="mr-2 rounded bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700 font-bold dark:bg-violet-900/30 dark:text-violet-300">{{ getAccountActionLabel(log.action) }}</span>
                <span v-if="log.accountName" class="mr-2 text-xs text-gray-500">{{ log.accountName }}</span>
                <span class="text-gray-700 dark:text-gray-300">{{ log.msg }}</span>
                <span v-if="log.reason" class="ml-2 text-orange-600 dark:text-orange-400">({{ log.reason }})</span>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- Right Column Stack -->
      <div class="flex flex-col gap-6 md:w-1/4">
        <!-- Next Checks -->
        <div class="flex flex-col rounded-lg bg-white p-6 shadow dark:bg-gray-800">
          <h3 class="mb-4 flex items-center gap-2 text-lg font-medium">
            <div class="i-carbon-hourglass" />
            <span>下次巡查倒计时</span>
          </h3>
          <div class="flex flex-col justify-center gap-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-sprout text-lg text-green-500" />
                <span>农场</span>
              </div>
              <div class="text-lg font-bold font-mono">
                {{ nextFarmCheck }}
              </div>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-user-multiple text-lg text-blue-500" />
                <span>帮助</span>
              </div>
              <div class="text-lg font-bold font-mono">
                {{ nextHelpCheck }}
              </div>
            </div>
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <div class="i-carbon-run text-lg text-orange-500" />
                <span>偷菜</span>
              </div>
              <div class="text-lg font-bold font-mono">
                {{ nextStealCheck }}
              </div>
            </div>
          </div>
        </div>

        <!-- Operations Grid -->
        <div class="flex-1 rounded-lg bg-white p-4 shadow dark:bg-gray-800">
          <h3 class="mb-3 flex items-center gap-2 text-lg font-medium">
            <div class="i-carbon-chart-column" />
            <span>今日统计</span>
          </h3>
          <div v-if="!status?.connection?.connected" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
            <div class="i-carbon-connection-signal-off text-4xl text-gray-400" />
            <div class="flex flex-col">
              <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
                账号未登录
              </div>
              <div class="mt-1 text-sm text-gray-400">
                请先运行账号或检查网络连接
              </div>
            </div>
          </div>
          <div v-else class="grid grid-cols-2 gap-2 2xl:gap-3">
            <div
              v-for="(val, key) in filteredOperations"
              :key="key"
              class="flex items-center justify-between rounded bg-gray-50 px-3 py-2 dark:bg-gray-700/30"
            >
              <div class="flex items-center gap-2">
                <div class="text-base 2xl:text-lg" :class="[getOpIcon(key), getOpColor(key)]" />
                <div class="text-xs text-gray-500 2xl:text-sm">
                  {{ getOpName(key) }}
                </div>
              </div>
              <div class="text-sm font-bold 2xl:text-base">
                {{ val }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
