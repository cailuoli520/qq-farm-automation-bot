import type { Socket } from 'socket.io-client'
import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { io } from 'socket.io-client'
import { ref } from 'vue'
import api from '@/api'
import { resolveLogLevel } from '@/features/logs/filter-options'

// Define interfaces for better type checking
interface DailyGift {
  key: string
  label: string
  enabled?: boolean
  doneToday: boolean
  lastAt?: number
  completedCount?: number
  totalCount?: number
  tasks?: any[]
}

interface DailyGiftsResponse {
  date: string
  growth: DailyGift
  gifts: DailyGift[]
}

export const useStatusStore = defineStore('status', () => {
  const status = ref<any>(null)
  const logs = ref<any[]>([])
  const accountLogs = ref<any[]>([])
  const dailyGifts = ref<DailyGiftsResponse | null>(null)
  const diamondBalance = ref(0)
  const loading = ref(false)
  const error = ref('')
  const realtimeConnected = ref(false)
  const realtimeLogsEnabled = ref(true)
  const currentRealtimeAccountId = ref('')
  const observedLogModules = ref<string[]>([])
  const observedLogEvents = ref<string[]>([])
  const observedLogEventModules = ref<Record<string, string[]>>({})
  const observedDevLogModules = ref<string[]>([])
  const observedDevLogEvents = ref<string[]>([])
  const observedDevLogEventModules = ref<Record<string, string[]>>({})
  const tokenRef = useStorage('admin_token', '')

  let socket: Socket | null = null
  let diamondRequestSequence = 0
  let logsRequestSequence = 0
  let accountLogsRequestSequence = 0

  function normalizeStatusPayload(input: any) {
    return (input && typeof input === 'object') ? { ...input } : {}
  }

  function normalizeLogEntry(input: any) {
    const entry = (input && typeof input === 'object') ? { ...input } : {}
    const ts = Number(entry.ts) || Date.parse(String(entry.time || '')) || Date.now()
    return {
      ...entry,
      level: resolveLogLevel(entry),
      ts,
      time: entry.time || new Date(ts).toISOString().replace('T', ' ').slice(0, 19),
    }
  }

  function observeLogEntry(entry: any) {
    const moduleName = String(entry?.meta?.module || '').trim()
    const eventName = String(entry?.meta?.event || '').trim()
    const isDev = entry?.meta?.dev === true
    const modules = isDev ? observedDevLogModules : observedLogModules
    const events = isDev ? observedDevLogEvents : observedLogEvents
    const eventModules = isDev ? observedDevLogEventModules : observedLogEventModules
    if (moduleName && !modules.value.includes(moduleName))
      modules.value = [...modules.value, moduleName]
    if (eventName && !events.value.includes(eventName))
      events.value = [...events.value, eventName]
    if (eventName && moduleName) {
      const knownModules = eventModules.value[eventName] || []
      if (!knownModules.includes(moduleName)) {
        eventModules.value = {
          ...eventModules.value,
          [eventName]: [...knownModules, moduleName],
        }
      }
    }
  }

  function belongsToCurrentRealtimeAccount(input: any) {
    const entry = (input && typeof input === 'object') ? input : {}
    const accountId = String(entry.accountId || '')
    return !currentRealtimeAccountId.value || !accountId || accountId === currentRealtimeAccountId.value
  }

  function pushRealtimeLog(entry: any) {
    if (!belongsToCurrentRealtimeAccount(entry))
      return
    const next = normalizeLogEntry(entry)
    observeLogEntry(next)
    logs.value.push(next)
    if (logs.value.length > 1000)
      logs.value = logs.value.slice(-1000)
  }

  function pushRealtimeAccountLog(entry: any) {
    const next = (entry && typeof entry === 'object') ? entry : {}
    const accountId = String(next.accountId || next.id || '')
    if (currentRealtimeAccountId.value && accountId !== currentRealtimeAccountId.value)
      return
    accountLogs.value.push(next)
    if (accountLogs.value.length > 300)
      accountLogs.value = accountLogs.value.slice(-300)
  }

  function handleRealtimeStatus(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || '')
    if (currentRealtimeAccountId.value && accountId !== currentRealtimeAccountId.value)
      return
    if (body.status && typeof body.status === 'object') {
      status.value = normalizeStatusPayload(body.status)
      error.value = ''
    }
  }

  function handleRealtimeLog(payload: any) {
    if (!realtimeLogsEnabled.value)
      return
    pushRealtimeLog(payload)
  }

  function handleRealtimeAccountLog(payload: any) {
    pushRealtimeAccountLog(payload)
  }

  function handleRealtimeLogsSnapshot(payload: any) {
    if (!realtimeLogsEnabled.value)
      return
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || '')
    if (currentRealtimeAccountId.value && accountId && accountId !== currentRealtimeAccountId.value)
      return
    const list = Array.isArray(body.logs) ? body.logs : []
    logs.value = list
      .filter((item: any) => belongsToCurrentRealtimeAccount(item))
      .map((item: any) => {
        const next = normalizeLogEntry(item)
        observeLogEntry(next)
        return next
      })
  }

  function handleRealtimeAccountLogsSnapshot(payload: any) {
    const body = (payload && typeof payload === 'object') ? payload : {}
    const accountId = String(body.accountId || '')
    if (currentRealtimeAccountId.value && accountId && accountId !== currentRealtimeAccountId.value)
      return
    const list = Array.isArray(body.logs) ? body.logs : []
    accountLogs.value = currentRealtimeAccountId.value
      ? list.filter((item: any) => String(item?.accountId || item?.id || '') === currentRealtimeAccountId.value)
      : list
  }

  function ensureRealtimeSocket() {
    if (socket)
      return socket

    socket = io('/', {
      path: '/socket.io',
      autoConnect: false,
      transports: ['websocket'],
      auth: {
        token: tokenRef.value,
      },
    })

    socket.on('connect', () => {
      realtimeConnected.value = true
      if (currentRealtimeAccountId.value) {
        socket?.emit('subscribe', { accountId: currentRealtimeAccountId.value })
      }
      else {
        socket?.emit('subscribe', { accountId: 'all' })
      }
    })

    socket.on('disconnect', () => {
      realtimeConnected.value = false
    })

    socket.on('connect_error', (err) => {
      realtimeConnected.value = false
      console.error('[realtime] 连接失败:', err.message)
    })

    socket.on('status:update', handleRealtimeStatus)
    socket.on('log:new', handleRealtimeLog)
    socket.on('account-log:new', handleRealtimeAccountLog)
    socket.on('logs:snapshot', handleRealtimeLogsSnapshot)
    socket.on('account-logs:snapshot', handleRealtimeAccountLogsSnapshot)
    return socket
  }

  function connectRealtime(accountId: string) {
    const nextAccountId = String(accountId || '').trim()
    if (nextAccountId !== currentRealtimeAccountId.value) {
      logsRequestSequence += 1
      accountLogsRequestSequence += 1
      logs.value = []
      accountLogs.value = []
      observedLogModules.value = []
      observedLogEvents.value = []
      observedLogEventModules.value = {}
      observedDevLogModules.value = []
      observedDevLogEvents.value = []
      observedDevLogEventModules.value = {}
    }
    currentRealtimeAccountId.value = nextAccountId
    if (!tokenRef.value)
      return

    const client = ensureRealtimeSocket()
    client.auth = {
      token: tokenRef.value,
      accountId: currentRealtimeAccountId.value || 'all',
    }

    if (client.connected) {
      client.emit('subscribe', { accountId: currentRealtimeAccountId.value || 'all' })
      return
    }
    client.connect()
  }

  function disconnectRealtime() {
    if (!socket)
      return
    socket.off('connect')
    socket.off('disconnect')
    socket.off('connect_error')
    socket.off('status:update', handleRealtimeStatus)
    socket.off('log:new', handleRealtimeLog)
    socket.off('account-log:new', handleRealtimeAccountLog)
    socket.off('logs:snapshot', handleRealtimeLogsSnapshot)
    socket.off('account-logs:snapshot', handleRealtimeAccountLogsSnapshot)
    socket.disconnect()
    socket = null
    realtimeConnected.value = false
  }

  async function fetchStatus(accountId: string) {
    if (!accountId)
      return
    loading.value = true
    try {
      const { data } = await api.get('/api/status', {
        headers: { 'x-account-id': accountId },
        skipErrorToast: true,
      } as any)
      if (data.ok) {
        status.value = normalizeStatusPayload(data.data)
        error.value = ''
      }
      else {
        error.value = data.error
      }
    }
    catch (e: any) {
      error.value = e.message
    }
    finally {
      loading.value = false
    }
  }

  async function fetchLogs(accountId: string, options: any = {}) {
    if (!accountId && options.accountId !== 'all')
      return false
    const requestedAccountId = String(accountId || options.accountId || '').trim()
    const sequence = ++logsRequestSequence
    const params: any = { limit: 100, ...options }
    const headers: any = {}
    if (accountId && accountId !== 'all') {
      headers['x-account-id'] = accountId
    }
    else {
      params.accountId = 'all'
    }

    try {
      const { data } = await api.get('/api/logs', { headers, params })
      if (sequence !== logsRequestSequence)
        return false
      if (requestedAccountId !== 'all' && currentRealtimeAccountId.value && requestedAccountId !== currentRealtimeAccountId.value)
        return false
      if (data.ok && Array.isArray(data.data)) {
        logs.value = data.data.map((item: any) => {
          const next = normalizeLogEntry(item)
          observeLogEntry(next)
          return next
        })
        error.value = ''
        return true
      }
      return false
    }
    catch (e: any) {
      if (sequence === logsRequestSequence)
        console.error(e)
      return false
    }
  }

  async function fetchDiamond(accountId: string) {
    const id = String(accountId || '').trim()
    if (!id)
      return
    const sequence = ++diamondRequestSequence
    diamondBalance.value = 0

    try {
      const { data } = await api.get('/api/diamond', {
        headers: { 'x-account-id': id },
        skipErrorToast: true,
      } as any)
      if (data.ok && sequence === diamondRequestSequence)
        diamondBalance.value = Math.max(0, Number(data.data?.diamond) || 0)
    }
    catch {
      // 钻石余额是补充数据，不应影响面板主流程
    }
  }

  async function fetchDailyGifts(accountId: string) {
    if (!accountId)
      return
    try {
      const { data } = await api.get('/api/daily-gifts', {
        headers: { 'x-account-id': accountId },
      })
      if (data.ok) {
        dailyGifts.value = data.data
      }
    }
    catch (e) {
      console.error('获取每日奖励失败', e)
    }
  }

  async function fetchAccountLogs(accountId = currentRealtimeAccountId.value, limit = 300) {
    const requestedAccountId = String(accountId || '').trim()
    const sequence = ++accountLogsRequestSequence
    try {
      const res = await api.get('/api/account-logs', {
        headers: requestedAccountId ? { 'x-account-id': requestedAccountId } : {},
        params: { limit: Math.max(1, Number(limit) || 100), accountId: requestedAccountId || undefined },
      })
      if (sequence !== accountLogsRequestSequence)
        return false
      if (requestedAccountId && currentRealtimeAccountId.value && requestedAccountId !== currentRealtimeAccountId.value)
        return false
      if (Array.isArray(res.data)) {
        accountLogs.value = res.data
        return true
      }
      return false
    }
    catch (e) {
      if (sequence === accountLogsRequestSequence)
        console.error(e)
      return false
    }
  }

  function setRealtimeLogsEnabled(enabled: boolean) {
    realtimeLogsEnabled.value = !!enabled
    if (realtimeLogsEnabled.value && socket?.connected)
      socket.emit('subscribe', { accountId: currentRealtimeAccountId.value || 'all' })
  }

  function invalidateLogRequests(clear = false) {
    logsRequestSequence += 1
    if (clear)
      logs.value = []
  }

  return {
    status,
    logs,
    accountLogs,
    dailyGifts,
    diamondBalance,
    loading,
    error,
    realtimeConnected,
    realtimeLogsEnabled,
    observedLogModules,
    observedLogEvents,
    observedLogEventModules,
    observedDevLogModules,
    observedDevLogEvents,
    observedDevLogEventModules,
    fetchStatus,
    fetchLogs,
    fetchAccountLogs,
    fetchDailyGifts,
    fetchDiamond,
    setRealtimeLogsEnabled,
    invalidateLogRequests,
    connectRealtime,
    disconnectRealtime,
  }
})
