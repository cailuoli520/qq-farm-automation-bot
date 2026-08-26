import type { ActivityEventKey, ActivityTabKey } from './types'

export interface ActivityTabDefinition {
  key: ActivityTabKey
  label: string
  theme: 'day' | 'night' | 'rain'
  brandImage?: string
  showRefresh: boolean
  showBalance: boolean
}

export const activityTabs: readonly ActivityTabDefinition[] = [
  { key: 'travel', label: '千星游记', theme: 'night', showRefresh: true, showBalance: true },
  { key: 'constellation', label: '观星礼录', theme: 'night', brandImage: '/activity-center/stellar/activity-title.png', showRefresh: false, showBalance: false },
  { key: 'shop', label: '星砂商店', theme: 'night', showRefresh: true, showBalance: true },
  { key: 'solar', label: '节令小礼', theme: 'day', showRefresh: true, showBalance: false },
  { key: 'qingmei', label: '青酿换万金', theme: 'night', showRefresh: true, showBalance: false },
  { key: 'qixi', label: '鹊桥寄情', theme: 'day', showRefresh: true, showBalance: false },
  { key: 'rainTasks', label: '气象任务', theme: 'rain', showRefresh: true, showBalance: false },
  { key: 'rainResearch', label: '气象研究', theme: 'rain', showRefresh: true, showBalance: false },
] as const

export interface ActivityEventDefinition {
  key: ActivityEventKey
  label: string
  tabs: readonly ActivityTabKey[]
}

export const activityEvents: readonly ActivityEventDefinition[] = [
  { key: 'stellar', label: '千灯垂野', tabs: ['travel', 'constellation', 'shop', 'solar'] },
  { key: 'rainPoetry', label: '雨落成诗', tabs: ['rainTasks', 'rainResearch'] },
  { key: 'qingmei', label: '青酿换万金', tabs: ['qingmei'] },
  { key: 'qixi', label: '鹊桥寄情', tabs: ['qixi'] },
] as const

export const activityTabByKey = Object.fromEntries(
  activityTabs.map(tab => [tab.key, tab]),
) as Record<ActivityTabKey, ActivityTabDefinition>
