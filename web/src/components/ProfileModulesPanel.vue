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
const { data, loading, error } = storeToRefs(modulesStore)

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
  if (acc.running && status.value?.connection?.connected)
    await modulesStore.fetchModules(currentAccountId.value)
}

function formatExpireAt(value: any) {
  const n = Number(value || 0)
  if (!n)
    return 'permanent/unknown'
  const ms = n > 1000000000000 ? n : n * 1000
  return new Date(ms).toLocaleString()
}

function formatSeconds(value: any) {
  const seconds = Number(value || 0)
  if (seconds <= 0)
    return 'none'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0)
    return `${days}d ${hours}h`
  if (hours > 0)
    return `${hours}h ${minutes}m`
  return `${minutes}m`
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
          Protocol Modules
        </h3>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Read-only module queries are enabled first to avoid risky automated actions.
        </p>
      </div>
      <button
        class="rounded-lg px-3 py-2 text-sm text-white disabled:opacity-60"
        :style="{ backgroundColor: 'var(--theme-primary)' }"
        :disabled="loading || !currentAccountId"
        @click="refresh"
      >
        {{ loading ? 'Refreshing...' : 'Refresh modules' }}
      </button>
    </div>

    <div
      v-if="!currentAccountId"
      class="rounded-xl bg-white p-8 text-center text-sm text-gray-500 shadow dark:bg-gray-800 dark:text-gray-400"
    >
      Select an account first.
    </div>

    <div
      v-else-if="!status?.connection?.connected"
      class="rounded-xl bg-white p-8 text-center text-sm text-gray-500 shadow dark:bg-gray-800 dark:text-gray-400"
    >
      Account is offline. Start it before reading protocol modules.
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
            Dog
          </h4>
          <span class="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            {{ dogCount }} dogs / {{ foodCount }} foods
          </span>
        </div>
        <div class="mb-3 grid grid-cols-2 gap-2 text-xs text-gray-500 dark:text-gray-400">
          <div>Guard left: {{ formatSeconds(data?.dog?.guardLeftSeconds) }}</div>
          <div>Equipped: #{{ data?.dog?.equippedDogId || 'none' }}</div>
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
              <span class="font-medium">{{ dog.name || `Dog #${dog.id}` }}</span>
              <span v-if="dog.equipped" class="text-xs text-green-500">equipped</span>
            </div>
            <div class="mt-1 text-xs text-gray-500">
              ID {{ dog.id }} / status {{ dog.status }} / intimacy {{ dog.intimacy }}
            </div>
          </div>
        </div>
        <div v-else class="text-sm text-gray-400">
          No dog data.
        </div>
      </section>

      <section class="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-3 flex items-center justify-between">
          <h4 class="flex items-center gap-2 font-semibold">
            <div class="i-carbon-color-palette text-emerald-500" />
            Skins
          </h4>
          <span class="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
            owned {{ skinOwnedCount }} / equipped {{ skinEquippedCount }}
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
            <div class="font-medium">Skin #{{ skin.id }}</div>
            <div class="mt-1 text-xs text-gray-500">
              type {{ skin.type }} / expires {{ formatExpireAt(skin.expireAt) }}
            </div>
          </div>
        </div>
        <div v-else class="text-sm text-gray-400">
          No skin data.
        </div>
      </section>

      <section class="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
        <div class="mb-3 flex items-center justify-between">
          <h4 class="flex items-center gap-2 font-semibold">
            <div class="i-carbon-user-avatar-filled text-sky-500" />
            Avatar Frames
          </h4>
          <span class="rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">
            {{ frameCount }} frames
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
            <div class="font-medium">Frame #{{ frame.id }}</div>
            <div class="mt-1 text-xs text-gray-500">
              type {{ frame.type }} / expires {{ formatExpireAt(frame.expireAt) }}
            </div>
          </div>
        </div>
        <div v-else class="text-sm text-gray-400">
          No avatar frame data.
        </div>
      </section>

      <section class="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
        <h4 class="mb-3 flex items-center gap-2 font-semibold">
          <div class="i-carbon-roadmap text-purple-500" />
          Pending Captures
        </h4>
        <div class="space-y-2 text-sm">
          <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
            <div class="font-medium">Career</div>
            <div class="mt-1 text-xs text-gray-500">
              {{ data?.career?.message || 'Needs capture.' }}
            </div>
          </div>
          <div class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
            <div class="font-medium">Golden Bug</div>
            <div class="mt-1 text-xs text-gray-500">
              {{ data?.goldenBug?.message || 'Needs capture.' }}
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
