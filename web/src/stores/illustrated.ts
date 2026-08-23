import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export const useIllustratedStore = defineStore('illustrated', () => {
  const data = ref<any>(null)
  const loading = ref(false)
  const error = ref('')
  let activeAccountId = ''
  let requestVersion = 0

  async function fetch(accountId: string) {
    const requestedAccountId = String(accountId || '').trim()
    if (!requestedAccountId)
      return
    if (activeAccountId !== requestedAccountId) {
      activeAccountId = requestedAccountId
      data.value = null
      error.value = ''
    }
    const version = ++requestVersion
    loading.value = true
    error.value = ''
    try {
      const response = await api.get('/api/illustrated', {
        headers: { 'x-account-id': requestedAccountId },
        timeout: 95000,
      })
      if (version !== requestVersion || activeAccountId !== requestedAccountId)
        return
      if (!response.data?.ok)
        throw new Error(response.data?.error || '图鉴加载失败')
      data.value = response.data.data
    }
    catch (caught: any) {
      if (version !== requestVersion || activeAccountId !== requestedAccountId)
        return
      data.value = null
      error.value = caught?.response?.data?.error || caught?.message || '图鉴加载失败'
    }
    finally {
      if (version === requestVersion && activeAccountId === requestedAccountId)
        loading.value = false
    }
  }

  function reset() {
    requestVersion += 1
    activeAccountId = ''
    data.value = null
    loading.value = false
    error.value = ''
  }

  return { data, loading, error, fetch, reset }
})
