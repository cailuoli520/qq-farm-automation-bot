<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, reactive, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { usePetStore } from '@/stores/pet'

const accountStore = useAccountStore()
const petStore = usePetStore()
const { snapshot, dogs, foods, activeDog, loading, operating, error } = storeToRefs(petStore)
const counts = reactive<Record<number, number>>({})
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

watch(accountId, refresh)
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

      <section class="grid gap-3 lg:grid-cols-3 sm:grid-cols-2">
        <article v-for="dog in dogs" :key="dog.id" class="flex items-center gap-3 border rounded-xl bg-white p-3 dark:border-gray-700 dark:bg-gray-800" :class="dog.owned ? '' : 'opacity-50 grayscale'">
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
    </template>
  </div>
</template>
