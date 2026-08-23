import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import api from '@/api'

export const usePetStore = defineStore('pet', () => {
  const snapshot = ref<any>(null)
  const loading = ref(false)
  const operating = ref(false)
  const error = ref('')
  const dogs = computed(() => snapshot.value?.dogs || [])
  const foods = computed(() => snapshot.value?.foods || [])
  const activeDog = computed(() => dogs.value.find((dog: any) => dog.active) || null)
  let activeAccountId = ''
  let stateVersion = 0
  let readVersion = 0
  let mutationVersion = 0
  let mutationAccountId = ''

  function activateAccount(accountId: string) {
    if (activeAccountId === accountId)
      return
    activeAccountId = accountId
    stateVersion += 1
    readVersion += 1
    mutationVersion += 1
    mutationAccountId = ''
    snapshot.value = null
    loading.value = false
    operating.value = false
    error.value = ''
  }

  async function request(accountId: string, operation: () => Promise<any>, mutation = false) {
    const requestedAccountId = String(accountId || '').trim()
    if (!requestedAccountId)
      return null
    activateAccount(requestedAccountId)
    if (mutation && operating.value && mutationAccountId === requestedAccountId)
      return null

    const writeVersion = ++stateVersion
    const lifecycleVersion = mutation ? ++mutationVersion : ++readVersion
    if (mutation) {
      mutationAccountId = requestedAccountId
      operating.value = true
    }
    else {
      loading.value = true
    }
    error.value = ''
    try {
      const response = await operation()
      if (activeAccountId !== requestedAccountId || writeVersion !== stateVersion)
        return null
      if (!response.data?.ok)
        throw new Error(response.data?.error || '宠物操作失败')
      snapshot.value = response.data.data
      return snapshot.value
    }
    catch (caught: any) {
      if (activeAccountId !== requestedAccountId || writeVersion !== stateVersion)
        return null
      error.value = caught?.response?.data?.error || caught?.message || '宠物操作失败'
      return null
    }
    finally {
      if (activeAccountId === requestedAccountId) {
        if (mutation && lifecycleVersion === mutationVersion) {
          mutationAccountId = ''
          operating.value = false
        }
        if (!mutation && lifecycleVersion === readVersion)
          loading.value = false
      }
    }
  }

  function fetch(accountId: string) {
    return request(accountId, () => api.get('/api/pets', {
      headers: { 'x-account-id': accountId },
      timeout: 95000,
    }))
  }

  function deploy(accountId: string, dogId: number) {
    return request(accountId, () => api.post('/api/pets/deploy', { dogId }, {
      headers: { 'x-account-id': accountId },
      timeout: 155000,
    }), true)
  }

  function withdraw(accountId: string) {
    return request(accountId, () => api.post('/api/pets/withdraw', {}, {
      headers: { 'x-account-id': accountId },
      timeout: 155000,
    }), true)
  }

  function useFood(accountId: string, itemId: number, count: number) {
    return request(accountId, () => api.post('/api/pets/food/use', { itemId, count }, {
      headers: { 'x-account-id': accountId },
      timeout: 155000,
    }), true)
  }

  function reset() {
    activeAccountId = ''
    stateVersion += 1
    readVersion += 1
    mutationVersion += 1
    mutationAccountId = ''
    snapshot.value = null
    loading.value = false
    operating.value = false
    error.value = ''
  }

  return { snapshot, dogs, foods, activeDog, loading, operating, error, fetch, deploy, withdraw, useFood, reset }
})
