<script setup lang="ts">
import type { RainPoetryActivityDto, RainWeatherCheckDto } from '@/stores/activity-center'
import { computed, ref, watch } from 'vue'

type ConfirmAction = { kind: 'exchange', id: string, title: string, detail: string } | { kind: 'collect', id: string, title: string, detail: string } | { kind: 'thunderstorm', id: string, title: string, detail: string } | { kind: 'research', id: string, title: string, detail: string }
type ResearchNode = RainPoetryActivityDto['researchNodes'][number]
type RainTask = RainPoetryActivityDto['tasks'][number]
type RainWeather = RainWeatherCheckDto['weather']

const props = defineProps<{
  mode: 'tasks' | 'research'
  activity: RainPoetryActivityDto | null
  friends: any[]
  friendsLoading: boolean
  weatherCheck: RainWeatherCheckDto | null
  weatherLoading: boolean
  weatherError: string
  pendingExchange: boolean
  pendingCollect: boolean
  pendingThunderstorm: boolean
  pendingResearch: boolean
}>()

const emit = defineEmits<{
  checkWeather: [friendGid: string, options?: { cacheOnly?: boolean, forceRefresh?: boolean }]
  refreshFriends: []
  exchange: [goodsId: string]
  collect: [friendGid: string]
  thunderstorm: []
  unlock: [nodeId: string]
  switchMode: [mode: 'tasks' | 'research']
}>()

const RAIN_ITEM_NAMES: Record<string, string> = {
  1027: '雷电徽章',
  2159: '雨落成诗纪念奖励',
  4002: '闪电变异瓶',
  4003: '霹雳引雷瓶',
  5001: '天气采集瓶',
  5002: '雷雨召唤瓶',
}

const selectedFriendGid = ref('')
const confirmation = ref<ConfirmAction | null>(null)
const busy = computed(() => props.pendingExchange || props.pendingCollect || props.pendingThunderstorm || props.pendingResearch)
const friendRows = computed(() => props.friends.filter(friend => String(friend?.gid || '')))
const researchById = computed(() => new Map((props.activity?.researchNodes || []).map(node => [node.id, node])))
const completedResearchCount = computed(() => props.activity?.researchNodes.filter(node => node.claimed).length || 0)
const nextResearchNode = computed(() => props.activity?.researchNodes.find(node => !node.claimed) || null)

watch(selectedFriendGid, (friendGid) => {
  confirmation.value = null
  if (friendGid)
    emit('checkWeather', friendGid, { cacheOnly: true })
})

function friendName(friend: any) {
  return String(friend?.remark || friend?.name || `好友 ${friend?.gid || ''}`)
}

function imageFor(itemId: string, fallback: string) {
  if (itemId === '1027')
    return '/activity-center/rain/badge.svg'
  if (itemId === '5001')
    return '/activity-center/rain/collection-bottle.svg'
  if (itemId === '5002')
    return '/activity-center/rain/thunderstorm-bottle.svg'
  return fallback
}

function displayName(item: { id: string, name: string }) {
  const name = String(item.name || '').trim()
  return name && !/^物品\s*#?\d+$/u.test(name) ? name : (RAIN_ITEM_NAMES[item.id] || '活动限定奖励')
}

function amount(value: string) {
  try {
    return BigInt(value || '0')
  }
  catch {
    return 0n
  }
}

function missingPrerequisites(node: ResearchNode) {
  return node.prerequisites.filter(id => !researchById.value.get(id)?.claimed)
}

function prerequisiteNames(node: ResearchNode, onlyMissing = false) {
  const ids = onlyMissing ? missingPrerequisites(node) : node.prerequisites
  return [...new Set(ids.map(id => researchById.value.get(id)).filter(Boolean).map(entry => displayName(entry!.reward)))]
}

function researchShortfall(node: ResearchNode) {
  const difference = amount(node.cost.count) - amount(props.activity?.balances.badge || '0')
  return difference > 0n ? difference : 0n
}

function researchButtonLabel(node: ResearchNode) {
  if (node.claimed)
    return '已解锁'
  if (props.pendingResearch && node.unlockable)
    return '解锁中'
  if (node.unlockable)
    return '解锁奖励'
  if (missingPrerequisites(node).length)
    return '需先完成前置'
  if (!props.activity?.balances.known)
    return '余额未知'
  if (researchShortfall(node) > 0n)
    return '徽章不足'
  return '暂不可解锁'
}

function researchStatus(node: ResearchNode) {
  if (node.claimed)
    return '奖励已领取，无需重复操作'
  const missing = prerequisiteNames(node, true)
  if (missing.length)
    return `先解锁：${missing.join('、')}`
  if (!props.activity?.balances.known)
    return '雷电徽章余额未知，请刷新页面'
  const shortfall = researchShortfall(node)
  if (shortfall > 0n)
    return `还差 ${shortfall} 枚雷电徽章`
  if (node.unlockable)
    return '条件已满足，现在可以解锁'
  return '条件已满足，等待活动开放；可刷新后再试'
}

const researchRecommendation = computed(() => {
  const node = nextResearchNode.value
  if (!node)
    return { title: '本期研究已全部完成', detail: '所有研究奖励都已领取。', goTasks: false }
  const reward = displayName(node.reward)
  if (node.unlockable)
    return { title: `下一步：解锁${reward}`, detail: `消耗 ${node.cost.count} 枚雷电徽章即可领取奖励。`, goTasks: false }
  const missing = prerequisiteNames(node, true)
  if (missing.length)
    return { title: '下一步：先完成前置研究', detail: `请先解锁${missing.join('、')}。`, goTasks: false }
  if (!props.activity?.balances.known)
    return { title: '下一步：刷新活动状态', detail: '雷电徽章余额尚未读取成功，刷新后再决定是否解锁。', goTasks: false }
  const shortfall = researchShortfall(node)
  if (shortfall > 0n)
    return { title: '下一步：去赚雷电徽章', detail: `还差 ${shortfall} 枚，完成气象任务即可获得。`, goTasks: true }
  return { title: '下一步：继续完成气象任务', detail: '研究条件由活动逐步开放，完成任务后刷新状态再回来查看。', goTasks: true }
})

function taskProgress(task: RainTask) {
  if (task.completed)
    return '已完成'
  return amount(task.target) > 0n ? `${task.progress}/${task.target}` : '进行中'
}

function collectionStatus(weather: RainWeather) {
  if (!weather.known)
    return '天气状态读取失败，请重新检查。'
  if (weather.thunderstorm)
    return props.activity?.actions.collect.enabled ? '检测到可采集雷雨，可以使用天气采集瓶。' : '检测到雷雨，但当前没有可用的天气采集瓶。'
  if (weather.active)
    return `${weather.name}不可采集；天气采集瓶只能用于雷雨。`
  return '好友当前天气晴朗，请换一位好友继续检查。'
}

function collectionButtonLabel(weather: RainWeather) {
  if (props.pendingCollect)
    return '采集中'
  if (!weather.known)
    return '天气未知'
  if (!weather.thunderstorm)
    return weather.active ? '仅雷雨可采集' : '等待雷雨'
  if (!props.activity?.actions.collect.enabled)
    return '缺少采集瓶'
  return '使用采集瓶'
}

function inspectedTime(value: number | null) {
  if (!value)
    return ''
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function confirmAction() {
  const action = confirmation.value
  if (!action)
    return
  confirmation.value = null
  if (action.kind === 'exchange')
    emit('exchange', action.id)
  else if (action.kind === 'collect')
    emit('collect', action.id)
  else if (action.kind === 'thunderstorm')
    emit('thunderstorm')
  else emit('unlock', action.id)
}
</script>

<template>
  <section class="rain-page">
    <div v-if="!activity" class="empty">
      当前账号未发现进行中的雨落成诗活动
    </div>
    <template v-else-if="mode === 'tasks'">
      <header class="hero">
        <div><small>限时气象活动</small><h2>{{ activity.name }}</h2><p>采集好友雷雨、召唤特殊天气，完成任务获得雷电徽章。</p></div>
        <span>{{ activity.active ? '进行中' : '已结束' }}</span>
      </header>

      <details class="guide" open>
        <summary><span>第一次来？照着 4 步玩</span><small>可收起</small></summary>
        <ol>
          <li><b>1</b><span><strong>兑换采集瓶</strong><small>每天用金豆豆兑换 1 个天气采集瓶。</small></span></li>
          <li><b>2</b><span><strong>寻找雷雨好友</strong><small>检查好友天气，在雷雨农场使用采集瓶。</small></span></li>
          <li><b>3</b><span><strong>完成气象任务</strong><small>获得雷雨召唤瓶并在自己的农场使用，按任务要求操作。</small></span></li>
          <li><b>4</b><span><strong>解锁研究奖励</strong><small>任务会给雷电徽章，到“气象研究”按前置条件兑换奖励。</small></span></li>
        </ol>
        <p><span class="status-chip">可操作</span> 表示该页现在有可点击的兑换、采集、召唤或研究操作，不是未读消息。</p>
      </details>

      <div class="balances">
        <article v-for="item in [activity.items.goldBean, activity.items.badge, activity.items.collectionBottle, activity.items.thunderstormBottle]" :key="item.id">
          <img v-if="imageFor(item.id, item.image)" :src="imageFor(item.id, item.image)" alt=""><span v-else class="item-placeholder" aria-hidden="true">?</span><span>{{ displayName(item) }}</span><strong>{{ activity.balances.known ? (item.count || '0') : '--' }}</strong>
        </article>
      </div>

      <section class="card weather-card">
        <div><small>我的农场天气</small><h3>{{ activity.weather.known ? activity.weather.name : '状态未知' }}</h3><p>{{ !activity.weather.known ? '天气状态读取失败，请刷新后再操作。' : activity.weather.active ? '特殊天气正在持续，结束前不可重复召唤。' : '当前没有特殊天气，可以使用雷雨召唤瓶。' }}</p></div>
        <button :disabled="busy || !activity.actions.thunderstorm.enabled" @click="confirmation = { kind: 'thunderstorm', id: '', title: '召唤雷雨', detail: '将消耗 1 个雷雨召唤瓶，在自己的农场召唤一场雷雨。' }">
          {{ pendingThunderstorm ? '使用中' : '使用召唤瓶' }}
        </button>
      </section>

      <section class="card">
        <div class="card-title">
          <div><small>每日兑换</small><h3>天气采集瓶</h3></div><span>金豆豆兑换</span>
        </div>
        <div v-for="goods in activity.exchangeItems" :key="goods.id" class="exchange-row">
          <img v-if="imageFor(goods.item.id, goods.item.image)" :src="imageFor(goods.item.id, goods.item.image)" alt=""><span v-else class="item-placeholder" aria-hidden="true">?</span><div><strong>{{ displayName(goods.item) }}</strong><small>消耗 {{ goods.cost.count }} {{ displayName(goods.cost) }}</small></div><button :disabled="busy || !goods.available" @click="confirmation = { kind: 'exchange', id: goods.id, title: '兑换天气采集瓶', detail: `将消耗 ${goods.cost.count} ${displayName(goods.cost)}，兑换 ${goods.item.count} 个${displayName(goods.item)}。` }">
            {{ goods.owned ? '今日已兑' : pendingExchange ? '兑换中' : '兑换' }}
          </button>
        </div>
      </section>

      <section class="card">
        <div class="card-title">
          <div><small>好友天气</small><h3>采集雷雨</h3></div><button class="text-button" :disabled="friendsLoading" @click="emit('refreshFriends')">
            刷新好友
          </button>
        </div>
        <div class="friend-control">
          <select v-model="selectedFriendGid" :disabled="busy || weatherLoading">
            <option value="" disabled>
              选择好友农场
            </option><option v-for="friend in friendRows" :key="friend.gid" :value="String(friend.gid)">
              {{ friendName(friend) }}
            </option>
          </select>
          <button :disabled="!selectedFriendGid || busy || weatherLoading" @click="emit('checkWeather', selectedFriendGid, { forceRefresh: true })">
            {{ weatherLoading ? '检查中' : '检查天气' }}
          </button>
        </div>
        <p v-if="weatherError" class="error">
          {{ weatherError }}
        </p>
        <div v-else-if="weatherCheck && weatherCheck.host.gid === selectedFriendGid" class="weather-result" :class="{ storm: weatherCheck.weather.thunderstorm }">
          <div class="weather-result-main">
            <span>{{ weatherCheck.host.name }}</span><strong>{{ weatherCheck.weather.name }}</strong><small>{{ collectionStatus(weatherCheck.weather) }}</small>
            <small v-if="weatherCheck.cached && weatherCheck.inspectedAt">巡查缓存 · {{ inspectedTime(weatherCheck.inspectedAt) }}</small>
            <small v-if="weatherCheck.pet">看家宠物：{{ weatherCheck.pet.name }}</small>
          </div>
          <button :disabled="busy || !weatherCheck.weather.thunderstorm || !activity.actions.collect.enabled" @click="confirmation = { kind: 'collect', id: weatherCheck.host.gid, title: '采集好友雷雨', detail: `将在 ${weatherCheck.host.name} 的农场消耗 1 个天气采集瓶；成功后获得雷雨召唤瓶。` }">
            {{ collectionButtonLabel(weatherCheck.weather) }}
          </button>
        </div>
      </section>

      <section class="card">
        <div class="card-title">
          <div><small>每日进度</small><h3>气象任务</h3></div><span>{{ activity.balances.badge }} 枚徽章</span>
        </div>
        <div v-for="(task, index) in activity.tasks" :key="task.id" class="task-row">
          <span :class="{ done: task.completed }">{{ task.completed ? '✓' : index + 1 }}</span><div><strong>{{ task.name }}</strong><small>{{ taskProgress(task) }} · 奖励 {{ displayName(task.reward) }} ×{{ task.reward.count }}</small></div>
        </div>
      </section>
    </template>

    <template v-else>
      <header class="hero research-hero">
        <div><small>研究与奖励</small><h2>雷电研究树</h2><p>先去“气象任务”获得雷电徽章，再按前置条件逐项解锁奖励。</p></div><strong>{{ activity.balances.known ? activity.balances.badge : '--' }} 枚</strong>
      </header>
      <section class="next-step" :class="{ ready: nextResearchNode?.unlockable }">
        <div><small>已解锁 {{ completedResearchCount }}/{{ activity.researchNodes.length }}</small><strong>{{ researchRecommendation.title }}</strong><p>{{ researchRecommendation.detail }}</p></div>
        <button v-if="researchRecommendation.goTasks" type="button" @click="emit('switchMode', 'tasks')">
          去气象任务
        </button>
      </section>
      <div class="research-tree">
        <article v-for="(node, index) in activity.researchNodes" :key="node.id" :class="{ claimed: node.claimed, available: node.unlockable }">
          <div class="node-icon">
            <img v-if="imageFor(node.reward.id, node.reward.image)" :src="imageFor(node.reward.id, node.reward.image)" alt=""><span v-else class="item-placeholder" aria-hidden="true">?</span><span>第 {{ index + 1 }} 项</span>
          </div>
          <div class="node-info">
            <strong>{{ displayName(node.reward) }} <b>×{{ node.reward.count }}</b></strong><small>{{ researchStatus(node) }}</small><p>需要 {{ node.cost.count }} {{ displayName(node.cost) }}</p>
          </div>
          <button :disabled="busy || !node.unlockable" @click="confirmation = { kind: 'research', id: node.id, title: `解锁${displayName(node.reward)}`, detail: `将消耗 ${node.cost.count} ${displayName(node.cost)}，领取 ${displayName(node.reward)} ×${node.reward.count}。` }">
            {{ researchButtonLabel(node) }}
          </button>
        </article>
      </div>
    </template>

    <div v-if="confirmation" class="confirm-mask" role="presentation" @click.self="confirmation = null">
      <section class="confirm-dialog" role="dialog" aria-modal="true" :aria-label="confirmation.title">
        <h3>{{ confirmation.title }}</h3><p>{{ confirmation.detail }}</p><div>
          <button class="cancel" :disabled="busy" @click="confirmation = null">
            取消
          </button><button :disabled="busy" @click="confirmAction">
            确认操作
          </button>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.rain-page {
  min-height: 100%;
  padding: calc(143px + env(safe-area-inset-top)) 14px 96px;
  color: #1d1d1f;
  background: transparent;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif;
}
.empty {
  margin: 24px 0;
  padding: 42px 20px;
  border: 1px solid rgba(60, 60, 67, 0.08);
  border-radius: 22px;
  color: #636366;
  background: rgba(255, 255, 255, 0.72);
  text-align: center;
  backdrop-filter: saturate(180%) blur(22px);
}
.hero {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 18px;
  border: 1px solid rgba(255, 255, 255, 0.68);
  border-radius: 24px;
  color: #1d1d1f;
  background: rgba(255, 255, 255, 0.74);
  box-shadow: 0 12px 36px rgba(45, 62, 74, 0.1);
  backdrop-filter: saturate(180%) blur(24px);
}
.hero small,
.card-title small {
  color: #007aff;
  font-weight: 650;
  letter-spacing: 0.04em;
}
.hero h2,
.card h3 {
  margin: 3px 0 5px;
  color: #1d1d1f;
  letter-spacing: -0.02em;
}
.hero h2 {
  font-size: 22px;
}
.hero p {
  max-width: 300px;
  margin: 0;
  color: #636366;
  font-size: 11px;
  line-height: 1.55;
}
.hero > span {
  align-self: start;
  padding: 5px 9px;
  border-radius: 999px;
  color: #248a3d;
  background: rgba(52, 199, 89, 0.12);
  font-size: 10px;
  font-weight: 650;
  white-space: nowrap;
}
.balances {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 10px 0;
}
.balances article {
  min-width: 0;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 1px solid rgba(60, 60, 67, 0.08);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 4px 18px rgba(45, 62, 74, 0.06);
  backdrop-filter: saturate(180%) blur(20px);
}
.balances img,
.exchange-row img,
.node-icon img {
  width: 36px;
  height: 36px;
  object-fit: contain;
}
.balances span {
  overflow: hidden;
  color: #636366;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.balances strong {
  color: #1d1d1f;
  font-size: 14px;
}
.guide {
  margin-top: 10px;
  padding: 14px 15px;
  border: 1px solid rgba(0, 122, 255, 0.12);
  border-radius: 20px;
  background: rgba(245, 250, 255, 0.86);
  box-shadow: 0 8px 28px rgba(45, 62, 74, 0.07);
  backdrop-filter: saturate(180%) blur(22px);
}
.guide summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #007aff;
  font-weight: 700;
  cursor: pointer;
  list-style: none;
}
.guide summary::-webkit-details-marker {
  display: none;
}
.guide summary small {
  color: #8e8e93;
  font-size: 10px;
  font-weight: 500;
}
.guide ol {
  margin: 13px 0 8px;
  padding: 0;
  display: grid;
  gap: 10px;
  list-style: none;
}
.guide li {
  display: flex;
  align-items: center;
  gap: 10px;
}
.guide li > b {
  width: 24px;
  height: 24px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 50%;
  color: white;
  background: #007aff;
  font-size: 11px;
}
.guide li span {
  min-width: 0;
  display: grid;
  gap: 1px;
}
.guide li strong {
  font-size: 12px;
}
.guide li small,
.guide > p {
  color: #636366;
  font-size: 10px;
  line-height: 1.5;
}
.guide > p {
  margin: 10px 0 0;
  padding-top: 9px;
  border-top: 1px solid rgba(60, 60, 67, 0.1);
}
.status-chip {
  display: inline-block;
  padding: 1px 5px;
  border-radius: 999px;
  color: #d92d20;
  background: rgba(255, 59, 48, 0.1);
  font-size: 9px;
  font-weight: 700;
}
.item-placeholder {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(0, 122, 255, 0.14);
  border-radius: 10px;
  color: #007aff;
  background: rgba(0, 122, 255, 0.08);
  font-weight: 700;
}
.card {
  margin-top: 10px;
  padding: 15px;
  border: 1px solid rgba(60, 60, 67, 0.08);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.76);
  box-shadow: 0 8px 28px rgba(45, 62, 74, 0.08);
  backdrop-filter: saturate(180%) blur(22px);
}
.card-title,
.weather-card,
.exchange-row,
.task-row,
.weather-result,
.friend-control {
  display: flex;
  align-items: center;
  gap: 10px;
}
.card-title,
.weather-card {
  justify-content: space-between;
}
.card-title small,
.node-info small,
.task-row small {
  display: block;
  color: #8e8e93;
  font-size: 10px;
}
.card-title > span {
  color: #636366;
  font-size: 11px;
}
.weather-card p {
  max-width: 265px;
  margin: 0;
  color: #8e8e93;
  font-size: 10px;
  line-height: 1.45;
}
button {
  min-height: 31px;
  padding: 7px 13px;
  border: 0;
  border-radius: 11px;
  color: white;
  background: #007aff;
  box-shadow: 0 2px 7px rgba(0, 122, 255, 0.2);
  font-weight: 650;
  cursor: pointer;
}
button:active:not(:disabled) {
  transform: scale(0.98);
}
button:disabled {
  color: #8e8e93;
  background: rgba(118, 118, 128, 0.12);
  box-shadow: none;
  cursor: not-allowed;
}
.text-button {
  min-height: auto;
  padding: 4px 6px;
  color: #007aff;
  background: transparent;
  box-shadow: none;
  font-size: 10px;
}
.exchange-row {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(60, 60, 67, 0.1);
}
.exchange-row div,
.task-row div,
.node-info {
  min-width: 0;
  flex: 1;
}
.exchange-row strong,
.node-info strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.exchange-row small {
  display: block;
  margin-top: 2px;
  color: #8e8e93;
}
.friend-control {
  margin-top: 10px;
}
.friend-control select {
  min-width: 0;
  min-height: 36px;
  flex: 1;
  padding: 8px 10px;
  border: 1px solid rgba(60, 60, 67, 0.16);
  border-radius: 11px;
  color: #1d1d1f;
  background: rgba(255, 255, 255, 0.8);
}
.weather-result {
  justify-content: space-between;
  margin-top: 10px;
  padding: 10px;
  border-radius: 13px;
  background: rgba(118, 118, 128, 0.08);
}
.weather-result.storm {
  background: rgba(0, 122, 255, 0.1);
}
.weather-result-main {
  min-width: 0;
  display: grid;
  flex: 1;
  gap: 2px;
}
.weather-result-main span,
.weather-result-main small {
  color: #636366;
}
.weather-result-main span {
  font-size: 10px;
}
.weather-result-main small {
  line-height: 1.35;
  font-size: 10px;
}
.error {
  color: #ff3b30;
  font-size: 11px;
}
.task-row {
  padding: 10px 0;
  border-top: 1px solid rgba(60, 60, 67, 0.1);
}
.task-row > span {
  width: 30px;
  height: 30px;
  display: grid;
  flex: none;
  place-items: center;
  border-radius: 9px;
  color: #636366;
  background: rgba(118, 118, 128, 0.1);
  font-weight: 650;
}
.task-row > span.done {
  color: #248a3d;
  background: rgba(52, 199, 89, 0.12);
}
.research-hero {
  align-items: center;
}
.research-hero > strong {
  padding: 7px 10px;
  border-radius: 999px;
  color: #b25000;
  background: rgba(255, 159, 10, 0.14);
  font-size: 12px;
}
.next-step {
  margin-top: 10px;
  padding: 14px 15px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid rgba(0, 122, 255, 0.14);
  border-radius: 18px;
  background: rgba(239, 247, 255, 0.88);
  box-shadow: 0 6px 22px rgba(0, 122, 255, 0.07);
  backdrop-filter: saturate(180%) blur(20px);
}
.next-step.ready {
  border-color: rgba(52, 199, 89, 0.22);
  background: rgba(242, 255, 246, 0.9);
}
.next-step div {
  min-width: 0;
  display: grid;
  gap: 3px;
}
.next-step small {
  color: #007aff;
  font-size: 10px;
  font-weight: 650;
}
.next-step strong {
  font-size: 13px;
}
.next-step p {
  margin: 0;
  color: #636366;
  font-size: 10px;
  line-height: 1.45;
}
.next-step button {
  flex: none;
}
.research-tree {
  display: grid;
  gap: 9px;
  margin-top: 11px;
}
.research-tree article {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 12px;
  border: 1px solid rgba(60, 60, 67, 0.08);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.68);
  box-shadow: 0 5px 20px rgba(45, 62, 74, 0.06);
  opacity: 0.72;
  backdrop-filter: saturate(180%) blur(20px);
}
.research-tree article.available {
  border-color: rgba(0, 122, 255, 0.22);
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 7px 24px rgba(0, 122, 255, 0.1);
  opacity: 1;
}
.research-tree article.claimed {
  border-color: rgba(52, 199, 89, 0.2);
  background: rgba(244, 255, 247, 0.82);
  opacity: 0.9;
}
.node-icon {
  position: relative;
  flex: none;
}
.node-icon span {
  position: absolute;
  right: -5px;
  bottom: -3px;
  padding: 2px 5px;
  border-radius: 7px;
  color: white;
  background: #636366;
  font-size: 8px;
  font-weight: 650;
  white-space: nowrap;
}
.node-info strong b {
  color: #636366;
  font-size: 11px;
}
.node-info p {
  margin: 4px 0 0;
  color: #b25000;
  font-size: 10px;
}
.confirm-mask {
  position: fixed;
  z-index: 80;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(10px);
}
.confirm-dialog {
  width: min(100%, 310px);
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.72);
  border-radius: 22px;
  color: #1d1d1f;
  background: rgba(248, 248, 250, 0.94);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.24);
  text-align: center;
  backdrop-filter: saturate(180%) blur(30px);
}
.confirm-dialog h3 {
  margin: 0 0 8px;
  font-size: 17px;
}
.confirm-dialog p {
  margin: 0 0 18px;
  color: #636366;
  line-height: 1.55;
}
.confirm-dialog div {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.confirm-dialog .cancel {
  color: #007aff;
  background: rgba(118, 118, 128, 0.12);
  box-shadow: none;
}

@media (max-width: 370px) {
  .rain-page {
    padding-right: 10px;
    padding-left: 10px;
  }
  .balances {
    grid-template-columns: 1fr;
  }
  .weather-card {
    align-items: flex-start;
  }
  .friend-control {
    align-items: stretch;
    flex-direction: column;
  }
  .research-tree article {
    gap: 8px;
    padding: 10px;
  }
  .research-tree article > button {
    padding-right: 10px;
    padding-left: 10px;
  }
}
</style>
