export type LogLevel = 'info' | 'warn' | 'error'

export interface LogFilterOption {
  label: string
  value: string
}

const MODULE_LABELS: Record<string, string> = {
  'farm': '农场',
  'friend': '好友',
  'warehouse': '仓库',
  'task': '任务',
  'system': '系统',
  'activity': '活动',
  'rain-poetry': '雨落成诗',
  'mall': '商城',
  'dog': '宠物',
  'mystery-shop': '神秘商店',
  'push': '推送',
  'scheduler': '调度',
}

const EVENT_LABELS: Record<string, string> = {
  farm_cycle: '农场巡查',
  harvest_crop: '收获作物',
  remove_plant: '清理枯株',
  plant_seed: '种植种子',
  fertilize: '施加化肥',
  lands_notify: '土地推送',
  seed_pick: '选择种子',
  seed_buy: '购买种子',
  fertilizer_buy: '购买化肥',
  fertilizer_gift_open: '开启礼包',
  task_scan: '获取任务',
  task_claim: '完成任务',
  mall_free_gifts: '免费礼包',
  daily_share: '分享奖励',
  vip_daily_gift: '会员礼包',
  month_card_gift: '月卡礼包',
  illustrated_rewards: '图鉴奖励',
  email_rewards: '邮箱领取',
  sell_success: '出售成功',
  upgrade_land: '土地升级',
  unlock_land: '土地解锁',
  friend_cycle: '好友巡查',
  visit_friend: '访问好友',
  auto_pause: '活动暂停',
  auto_exchange: '自动兑换',
  auto_collect: '天气采集',
  auto_thunderstorm: '雷雨召唤',
  auto_research: '研究解锁',
  friend_scan: '活动好友扫描',
  auto_cycle: '活动自动循环',
  active_query: '查询当前神秘商人',
  auto_buy: '神秘商人自动购买',
  battle_pass_push_claim: '战令推送领取',
  battle_pass_push_claim_error: '战令推送领取失败',
  check_fertilizer: '化肥容器检测',
  check_fertilizer_normal: '普通化肥容器检测',
  check_fertilizer_organic: '有机化肥容器检测',
  fertilizer_auto_buy: '化肥自动购买',
  interact_records: '访客记录',
  missing_image: '缺少物品图片',
  notify: '消息提醒',
  push_init_error: '推送监听初始化失败',
  unhandled_push: '未处理推送',
}

function buildOptions(allLabel: string, labels: Record<string, string>, observed: string[]): LogFilterOption[] {
  const known = Object.entries(labels).map(([value, label]) => ({ label, value }))
  const unknown = [...new Set(observed.map(value => String(value || '').trim()).filter(Boolean))]
    .filter(value => !labels[value])
    .sort((a, b) => a.localeCompare(b))
    .map(value => ({ label: value, value }))
  return [{ label: allLabel, value: '' }, ...known, ...unknown]
}

export function buildModuleOptions(observed: string[]): LogFilterOption[] {
  return buildOptions('所有模块', MODULE_LABELS, observed)
}

export function buildEventOptions(
  observed: string[],
  selectedModule = '',
  eventModules: Record<string, string[]> = {},
): LogFilterOption[] {
  const values = [...new Set(observed.map(value => String(value || '').trim()).filter(Boolean))]
    .filter(value => !selectedModule || (eventModules[value] || []).includes(selectedModule))
  return [
    { label: '所有事件', value: '' },
    ...values.map(value => ({ label: EVENT_LABELS[value] || value, value })),
  ]
}

export function getEventLabel(event: unknown): string {
  const key = String(event || '')
  return EVENT_LABELS[key] || key
}

export function resolveLogLevel(log: any): LogLevel {
  const explicit = String(log?.level || '').toLowerCase()
  if (explicit === 'warn' || explicit === 'error')
    return explicit
  if (explicit === 'info')
    return 'info'
  if (String(log?.tag || '') === '错误')
    return 'error'
  return log?.isWarn === true ? 'warn' : 'info'
}
