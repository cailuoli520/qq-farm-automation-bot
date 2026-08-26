<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { usePetStore } from '@/stores/pet'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const petStore = usePetStore()
const toast = useToastStore()
const {
  snapshot,
  dogs,
  foods,
  activeDog,
  loading,
  operating,
  error,
  giftError,
  protectLogs,
  protectLogsTotal,
  protectLogsLoading,
} = storeToRefs(petStore)
const counts = reactive<Record<number, number>>({})
const showProtectLogs = ref(false)
const accountId = computed(() => String((accountStore.currentAccountId as any)?.value ?? accountStore.currentAccountId ?? ''))
const durationPercent = computed(() => {
  const current = Number(snapshot.value?.protectDuration) || 0
  const max = Number(snapshot.value?.maxProtectDuration) || 1
  return Math.min(100, Math.round(current / max * 100))
})

function formatDuration(value: unknown) {
  let seconds = Math.max(0, Math.floor(Number(value) || 0))
  const days = Math.floor(seconds / 86400)
  seconds %= 86400
  const hours = Math.floor(seconds / 3600)
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时`
}

function refresh() {
  if (accountId.value)
    return petStore.fetch(accountId.value)
  petStore.reset()
}

function maxFoodCount(food: any) {
  const remain = Math.max(0, Number(snapshot.value?.maxProtectDuration) - Number(snapshot.value?.protectDuration))
  return Math.max(0, Math.min(Number(food.count) || 0, Math.floor(remain / (Number(food.duration) || 1))))
}

function useFood(food: any) {
  const max = maxFoodCount(food)
  const count = Math.min(max, Math.max(1, Math.trunc(Number(counts[food.id]) || 1)))
  if (count > 0)
    return petStore.useFood(accountId.value, food.id, count)
}

async function claimGifts() {
  const result = await petStore.claimGifts(accountId.value)
  if (!result) {
    toast.error(giftError.value || '领取同气连枝礼包失败')
    return
  }
  const claimed = Math.max(0, Number(result.claimed) || 0)
  if (claimed > 0)
    toast.success(`已领取同气连枝礼包 x${claimed}`)
  else
    toast.info('当前没有待领取的同气连枝礼包')
}

async function toggleProtectLogs() {
  showProtectLogs.value = !showProtectLogs.value
  if (showProtectLogs.value && protectLogs.value.length === 0)
    await petStore.fetchProtectLogs(accountId.value)
}

function formatRecordTime(value: unknown) {
  const seconds = Number(value) || 0
  if (seconds <= 0)
    return '未知时间'
  return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false })
}

watch(accountId, () => {
  showProtectLogs.value = false
  refresh()
})
onMounted(refresh)
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h3 class="flex items-center gap-2 text-xl font-bold">
          <span class="i-carbon-dog-walker" />宠物
        </h3><p class="mt-1 text-sm text-gray-500">
          查看宠物、切换看护并手动补充狗粮
        </p>
      </div>
      <button class="rounded-lg bg-gray-100 px-3 py-2 text-sm dark:bg-gray-800" :disabled="loading || operating" @click="refresh">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
    </div>
    <div v-if="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/30">
      {{ error }}
    </div>
    <template v-if="snapshot">
      <section class="border rounded-xl bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-2 flex justify-between">
          <strong>{{ activeDog ? `${activeDog.name} 正在看家` : '暂无宠物上场' }}</strong><span class="text-sm text-gray-500">{{ formatDuration(snapshot.protectDuration) }}</span>
        </div>
        <div class="h-2 overflow-hidden rounded bg-gray-100 dark:bg-gray-700">
          <div class="h-full bg-amber-500" :style="{ width: `${durationPercent}%` }" />
        </div>
      </section>

      <section v-if="Number(snapshot.pendingGiftCount) > 0" class="border border-amber-200 rounded-xl bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
        <div class="flex flex-wrap items-center gap-3">
          <span class="i-carbon-gift text-2xl text-amber-600" />
          <div class="min-w-0 flex-1">
            <strong>同气连枝礼包待领取 x{{ snapshot.pendingGiftCount }}</strong>
            <p class="mt-1 text-xs text-gray-500">
              好友协助农场时由护主犬技能掉落，领取后奖励直接进入背包。
            </p>
          </div>
          <button class="rounded bg-amber-600 px-3 py-2 text-sm text-white disabled:opacity-40" :disabled="operating" @click="claimGifts">
            {{ operating ? '领取中…' : '全部领取' }}
          </button>
        </div>
        <p v-if="giftError" class="mt-2 text-xs text-red-600">
          {{ giftError }}
        </p>
      </section>

      <section class="grid gap-3 lg:grid-cols-3 sm:grid-cols-2">
        <article v-for="dog in dogs" :key="dog.id" class="border rounded-xl bg-white p-3 dark:border-gray-700 dark:bg-gray-800" :class="dog.owned ? '' : 'opacity-50 grayscale'">
          <div class="flex items-center gap-3">
            <div class="h-14 w-14 flex shrink-0 items-center justify-center">
              <img v-if="dog.image" :src="dog.image" class="max-h-full max-w-full object-contain"><span v-else class="i-carbon-dog-walker text-3xl text-gray-300" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">
                {{ dog.name }}
              </div><div class="text-xs text-gray-500">
                {{ dog.rarityLabel }} · Lv.{{ dog.level || 0 }}
              </div>
            </div>
            <button class="rounded px-2 py-1 text-xs" :class="dog.active ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'" :disabled="!dog.owned || operating" @click="dog.active ? petStore.withdraw(accountId) : petStore.deploy(accountId, dog.id)">
              {{ dog.owned ? (dog.active ? '收回' : '上场') : '未获得' }}
            </button>
          </div>
          <div v-if="dog.skills?.length" class="mt-3 border-t pt-2 text-xs space-y-2 dark:border-gray-700">
            <div v-for="skill in dog.skills" :key="`${dog.id}-${skill.name}`">
              <div class="flex items-center justify-between gap-2 font-medium">
                <span>{{ skill.name }}</span>
                <span v-if="skill.dailyLimit" class="text-emerald-600">今日剩余 {{ skill.remainingCount ?? skill.dailyLimit }}/{{ skill.dailyLimit }}</span>
              </div>
              <p class="mt-1 text-gray-500 leading-relaxed">
                {{ skill.description }}
              </p>
            </div>
          </div>
        </article>
      </section>

      <section class="border rounded-xl bg-white p-4 space-y-2 dark:border-gray-700 dark:bg-gray-800">
        <h4 class="font-bold">
          狗粮
        </h4>
        <div v-for="food in foods" :key="food.id" class="flex flex-wrap items-center gap-3 border-t py-2 first:border-t-0 dark:border-gray-700">
          <img v-if="food.image" :src="food.image" class="h-9 w-9 object-contain"><span v-else class="i-carbon-restaurant text-2xl text-gray-300" />
          <div class="min-w-0 flex-1">
            <div class="font-medium">
              {{ food.name }}
            </div><div class="text-xs text-gray-500">
              库存 {{ food.count }} · 每份 {{ formatDuration(food.duration) }}
            </div>
          </div>
          <input v-model.number="counts[food.id]" type="number" min="1" :max="maxFoodCount(food)" class="w-16 border rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-900">
          <button class="rounded bg-emerald-600 px-3 py-1 text-sm text-white disabled:opacity-40" :disabled="!activeDog || maxFoodCount(food) <= 0 || operating" @click="useFood(food)">
            使用
          </button>
        </div>
      </section>

      <section class="border rounded-xl bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h4 class="font-bold">
              守护记录
            </h4>
            <p class="mt-1 text-xs text-gray-500">
              查看宠物阻止偷菜并获得金币的历史记录
            </p>
          </div>
          <button class="rounded bg-gray-100 px-3 py-2 text-sm dark:bg-gray-700" :disabled="protectLogsLoading" @click="toggleProtectLogs">
            {{ protectLogsLoading ? '加载中…' : (showProtectLogs ? '收起' : '查看') }}
          </button>
        </div>
        <div v-if="showProtectLogs" class="mt-3 border-t pt-3 space-y-2 dark:border-gray-700">
          <div class="text-xs text-gray-500">
            共 {{ protectLogsTotal }} 条
          </div>
          <div v-if="protectLogs.length === 0 && !protectLogsLoading" class="py-4 text-center text-sm text-gray-500">
            暂无守护记录
          </div>
          <div v-for="record in protectLogs" :key="record.id" class="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900/50">
            <div>
              <strong>{{ record.friendName }}</strong>
              <div class="mt-1 text-xs text-gray-500">
                {{ formatRecordTime(record.timestamp) }} · {{ record.dogName || `宠物#${record.dogId}` }}
              </div>
            </div>
            <div class="text-right text-xs">
              <div>阻止偷取 {{ record.stolenCount }}</div>
              <div class="mt-1 text-amber-600">
                获得金币 {{ record.protectedGold }}
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
