<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useAccountStore } from '@/stores/account'
import { useIllustratedStore } from '@/stores/illustrated'

const accountStore = useAccountStore()
const illustratedStore = useIllustratedStore()
const { data, loading, error } = storeToRefs(illustratedStore)
const currentType = ref<'crop' | 'mutant'>('crop')
const currentAccountId = computed(() => String((accountStore.currentAccountId as any)?.value ?? accountStore.currentAccountId ?? ''))
const book = computed(() => data.value?.[currentType.value] || null)
const collectedCount = computed(() => (book.value?.items || []).filter((item: any) => item.unlocked).length)
const progressPercent = computed(() => {
  const current = Number(book.value?.progress) || 0
  const target = Number(book.value?.nextLevelProgress) || 0
  return target > 0 ? Math.min(100, Math.max(0, current / target * 100)) : 0
})

async function refresh() {
  if (currentAccountId.value)
    await illustratedStore.fetch(currentAccountId.value)
  else
    illustratedStore.reset()
}

watch(currentAccountId, refresh)
onMounted(refresh)
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 class="flex items-center gap-2 text-xl font-bold">
          <span class="i-carbon-book text-amber-600" />图鉴
        </h3>
        <p class="mt-1 text-sm text-gray-500">
          查看普通作物和超变果实的收藏进度
        </p>
      </div>
      <button class="rounded-lg bg-gray-100 px-3 py-2 text-sm dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700" :disabled="loading" @click="refresh">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
    </div>

    <div class="flex gap-2">
      <button v-for="type in ([['crop', '作物图鉴'], ['mutant', '超变图鉴']] as const)" :key="type[0]" class="rounded-lg px-4 py-2 text-sm" :class="currentType === type[0] ? 'bg-emerald-600 text-white' : 'bg-white dark:bg-gray-800'" @click="currentType = type[0]">
        {{ type[1] }}
      </button>
    </div>

    <div v-if="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/30">
      {{ error }}
    </div>
    <div v-else-if="book" class="space-y-4">
      <section class="border rounded-xl bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div class="mb-2 flex justify-between text-sm">
          <strong>等级 {{ book.level || 0 }}</strong><span>{{ book.progress || 0 }} / {{ book.nextLevelProgress || '-' }}</span>
        </div>
        <div class="h-2 overflow-hidden rounded bg-gray-100 dark:bg-gray-700">
          <div class="h-full bg-emerald-500 transition-all" :style="{ width: `${progressPercent}%` }" />
        </div>
        <div class="mt-2 text-xs text-gray-500">
          已收藏 {{ collectedCount }} / {{ book.items?.length || 0 }}
        </div>
      </section>

      <section class="grid grid-cols-2 gap-3 lg:grid-cols-6 md:grid-cols-4 sm:grid-cols-3">
        <article v-for="item in book.items" :key="item.seedId" class="relative border rounded-xl bg-white p-3 text-center dark:border-gray-700 dark:bg-gray-800" :class="item.unlocked ? '' : 'opacity-45 grayscale'">
          <span v-if="item.isNew" class="absolute right-1 top-1 rounded bg-red-500 px-1 text-[10px] text-white">NEW</span>
          <div class="mx-auto mb-2 h-14 w-14 flex items-center justify-center">
            <img v-if="item.image" :src="item.image" class="max-h-full max-w-full object-contain" loading="lazy" referrerpolicy="no-referrer">
            <span v-else class="i-carbon-sprout text-3xl text-gray-300" />
          </div>
          <div class="truncate text-sm font-medium" :title="item.name">
            {{ item.name }}
          </div>
          <div class="mt-1 text-xs text-gray-500">
            进度 {{ item.progress || 0 }}
          </div>
        </article>
      </section>
    </div>
    <div v-else-if="!loading" class="border rounded-xl border-dashed p-8 text-center text-gray-500 dark:border-gray-700">
      暂无图鉴数据
    </div>
  </div>
</template>
