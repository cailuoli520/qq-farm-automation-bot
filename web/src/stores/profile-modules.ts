import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'

export const useProfileModulesStore = defineStore('profile-modules', () => {
  const data = ref<any>(null)
  const loading = ref(false)
  const error = ref('')

  async function fetchModules(accountId: string) {
    if (!accountId)
      return

    loading.value = true
    error.value = ''
    try {
      const res = await api.get('/api/profile/modules', {
        headers: { 'x-account-id': accountId },
      })
      if (res.data?.ok) {
        data.value = res.data.data || null
      }
      else {
        data.value = null
        error.value = res.data?.error || '加载失败'
      }
    }
    catch (e: any) {
      data.value = null
      error.value = e?.response?.data?.error || e?.message || '加载失败'
    }
    finally {
      loading.value = false
    }
  }

  function clear() {
    data.value = null
    error.value = ''
  }

  return { data, loading, error, fetchModules, clear }
})
