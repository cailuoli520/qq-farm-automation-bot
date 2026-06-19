<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { useProfileModulesStore } from '@/stores/profile-modules'
import { useStatusStore } from '@/stores/status'

const accountStore = useAccountStore()
const statusStore = useStatusStore()
const modulesStore = useProfileModulesStore()

const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { status, realtimeConnected } = storeToRefs(statusStore)
const { data, solarTerms, activities, loading, actionLoading, error } = storeToRefs(modulesStore)

const dogCount = computed(() => data.value?.dog?.dogs?.length || 0)
const foodCount = computed(() => data.value?.dog?.foods?.length || 0)
const skinOwnedCount = computed(() => data.value?.skins?.owned?.length || 0)
const skinEquippedCount = computed(() => data.value?.skins?.equipped?.length || 0)
const frameCount = computed(() => data.value?.avatarFrames?.owned?.length || 0)

async function refresh() {
  if (!currentAccountId.value)
    return
  const acc = currentAccount.value
  if (!acc)
    return
  if (!realtimeConnected.value)
    await statusStore.fetchStatus(currentAccountId.value)
  if (acc.running && status.value?.connection?.connected) {
    await modulesStore.fetchModules(currentAccountId.value)
    await modulesStore.fetchSolarTerms(currentAccountId.value).catch(() => undefined)
    await modulesStore.fetchActivities(currentAccountId.value).catch(() => undefined)
  }
}

async function feedDog(foodId: number) {
  if (!currentAccountId.value || !foodId)
    return
  await modulesStore.addDogFood(currentAccountId.value, foodId, 1)
}

async function claimSolarTermGift() {
  if (!currentAccountId.value)
    return
  await modulesStore.claimSolarTerms(currentAccountId.value, solarTerms.value?.currentSolarTermId)
}

function formatExpireAt(value: any) {
  const n = Number(value || 0)
  if (!n)
    return '永久/未知'
  const ms = n > 1000000000000 ? n : n * 1000
  return new Date(ms).toLocaleString()
}

function formatSeconds(value: any) {
  const seconds = Number(value || 0)
  if (seconds <= 0)
    return '无'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0)
    return `${days}天 ${hours}小时`
  if (hours > 0)
    return `${hours}小时 ${minutes}分钟`
  return `${minutes}分钟`
}

onMounted(refresh)

watch(currentAccountId, () => {
  modulesStore.clear()
  refresh()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 shadow dark:bg-gray-800">
      <div>
        <h3 class="flex items-center gap-2 text-base font-semibold">
          <div class="i-carbon-chip text-blue-500" />
          新版协议模块
        </h3>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          优先接入低风险查询和手动操作，避免不明确的自动化触发风控。
        </p>
      </div>
      <button
        class="rounded-lg px-3 py-2 text-sm text-white disabled:opacity-60"
        :style="{ backgroundColor: 'var(--theme-primary)' }"
        :disabled="loading || !currentAccountId"
        @click="refresh"
      >
        {{ loading ? '刷新中...' : '刷新模块' }}
      </button>
    </div>

    <div
      v-if="!currentAccountId"
      class="rounded-xl bg-white p-8 text-center text-sm text-gray-500 shadow dark:bg-gray-800 dark:text-gray-400"
    >
      请先选择账号。
    </div>

    <div
      v-else-if="!status?.connection?.connected"
      class="rounded-xl bg-white p-8 text-center text-sm text-gray-500 shadow dark:bg-gray-800 dark:text-gray-400"
    >
      账号未在线，请先启动账号后再读取新版模块。
    </div>

    <div
      v-else-if="error"
      class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
    >
      {{ error }}
    </div>

    <div v-else class="grid gap-4 lg:grid-cols-2">
      <section class="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-3 flex items-center justify-between">
          <h4 class="flex items-center gap-2 font-semibold">
            <div class="i-carbon-pets text-amber-500" />
            狗狗
          </h4>
          <span class="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            {{ dogCount }} 只狗 / {{ foodCount }} 种狗粮
          </span>
        </div>
        <div class="mb-3 grid grid-cols-2 gap-2 text-xs text-gray-500 dark:text-gray-400">
          <div>护院剩余：{{ formatSeconds(data?.dog?.guardLeftSeconds) }}</div>
          <div>当前狗狗：#{{ data?.dog?.equippedDogId || '无' }}</div>
        </div>
        <div v-if="data?.dog?.error" class="text-sm text-red-500">
          {{ data.dog.error }}
        </div>
        <div v-else-if="dogCount" class="space-y-2">
          <div
            v-for="dog in data.dog.dogs"
            :key="dog.id"
            class="rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900/40"
          >
            <div class="flex justify-between">
              <span class="font-medium">{{ dog.name || `狗狗 #${dog.id}` }}</span>
              <span v-if="dog.equipped" class="text-xs text-green-500">已装备</span>
            </div>
            <div class="mt-1 text-xs text-gray-500">
              ID {{ dog.id }} / 状态 {{ dog.status }} / 亲密度 {{ dog.intimacy }}
            </div>
          </div>
        </div>
        <div v-else class="text-sm text-gray-400">
          暂无狗狗数据。
        </div>
        <div v-if="data?.dog?.foods?.length" class="mt-4 border-t border-gray-100 pt-3 dark:border-gray-700">
          <div class="mb-2 text-xs font-semibold text-gray-500">
            狗粮
          </div>
          <div class="grid gap-2">
            <div
              v-for="food in data.dog.foods"
              :key="food.id"
              class="flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-sm dark:bg-amber-900/20"
            >
              <span>狗粮 #{{ food.id }} x{{ food.count }}</span>
              <button
                class="rounded bg-amber-500 px-2 py-1 text-xs text-white disabled:opacity-50"
                :disabled="actionLoading || food.count <= 0"
                @click="feedDog(food.id)"
              >
                喂 1 个
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-3 flex items-center justify-between">
          <h4 class="flex items-center gap-2 font-semibold">
            <div class="i-carbon-color-palette text-emerald-500" />
            装扮
          </h4>
          <span class="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
            拥有 {{ skinOwnedCount }} / 已穿戴 {{ skinEquippedCount }}
          </span>
        </div>
        <div v-if="data?.skins?.error" class="text-sm text-red-500">
          {{ data.skins.error }}
        </div>
        <div v-else-if="skinOwnedCount || skinEquippedCount" class="grid gap-2 text-sm sm:grid-cols-2">
          <div
            v-for="skin in data.skins.owned"
            :key="`owned-${skin.id}`"
            class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40"
          >
            <div class="font-medium">装扮 #{{ skin.id }}</div>
            <div class="mt-1 text-xs text-gray-500">
              类型 {{ skin.type }} / 到期 {{ formatExpireAt(skin.expireAt) }}
            </div>
          </div>
        </div>
        <div v-else class="text-sm text-gray-400">
          暂无装扮数据。
        </div>
      </section>

      <section class="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-3 flex items-center justify-between">
          <h4 class="flex items-center gap-2 font-semibold">
            <div class="i-carbon-user-avatar-filled text-sky-500" />
            头像框
          </h4>
          <span class="rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
            {{ frameCount }} 个头像框
          </span>
        </div>
        <div v-if="data?.avatarFrames?.error" class="text-sm text-red-500">
          {{ data.avatarFrames.error }}
        </div>
        <div v-else-if="frameCount" class="grid gap-2 text-sm sm:grid-cols-2">
          <div
            v-for="frame in data.avatarFrames.owned"
            :key="frame.id"
            class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40"
          >
            <div class="font-medium">头像框 #{{ frame.id }}</div>
            <div class="mt-1 text-xs text-gray-500">
              类型 {{ frame.type }} / 到期 {{ formatExpireAt(frame.expireAt) }}
            </div>
          </div>
        </div>
        <div v-else class="text-sm text-gray-400">
          暂无头像框数据。
        </div>
      </section>

      <section class="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
        <h4 class="mb-3 flex items-center gap-2 font-semibold">
          <div class="i-carbon-roadmap text-purple-500" />
          新活动模块
        </h4>
        <div class="space-y-2 text-sm">
          <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
            <div class="flex items-center justify-between gap-2">
              <div>
                <div class="font-medium">节气礼包</div>
                <div class="mt-1 text-xs text-gray-500">
                  节气项 {{ solarTerms?.termCount ?? '-' }} / 服务器时间 {{ solarTerms?.serverTime || '-' }}
                </div>
              </div>
              <button
                class="rounded bg-green-600 px-2 py-1 text-xs text-white disabled:opacity-50"
                :disabled="actionLoading || !solarTerms?.currentSolarTermId"
                @click="claimSolarTermGift"
              >
                领取
              </button>
            </div>
          </div>
          <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
            <div class="font-medium">活动 / 助威</div>
            <div class="mt-1 text-xs text-gray-500">
              活动数 {{ activities?.list?.activityCount ?? '-' }} / 活动组数据 {{ activities?.summerGroup?.payloadLength ?? '-' }}
            </div>
            <div class="mt-1 text-xs text-amber-600 dark:text-amber-300">
              已抓到 Operate 请求，但活动参数语义还没完全确认，暂不开放自动助威。
            </div>
          </div>
          <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
            <div class="font-medium">个人生涯</div>
            <div class="mt-1 text-xs text-gray-500">
              {{ data?.career?.message || '需要继续抓包。' }}
            </div>
          </div>
          <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
            <div class="font-medium">黄金虫</div>
            <div class="mt-1 text-xs text-gray-500">
              {{ data?.goldenBug?.message || '需要继续抓包。' }}
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
