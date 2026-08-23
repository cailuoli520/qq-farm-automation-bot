<script setup lang="ts">
import type { QixiActivityDto, QixiDewTargetsDto } from '@/stores/activity-center'
import { computed, ref } from 'vue'

const props = defineProps<{
  activity: QixiActivityDto | null
  friends: any[]
  friendsLoading: boolean
  dewTargets: QixiDewTargetsDto | null
  dewTargetsLoading: boolean
  dewTargetsError: string
  pendingBridge: boolean
  pendingGift: boolean
  pendingDew: boolean
}>()

const emit = defineEmits<{
  claimBridge: []
  gift: [friendGid: string]
  loadDewTargets: [hostGid: string]
  useDew: [hostGid: string, landId: string]
  refreshFriends: []
}>()

const selectedGiftGid = ref('')
const selectedHostGid = ref('')
const friends = computed(() => props.friends.filter(friend => String(friend?.gid || '')))
const busy = computed(() => props.pendingBridge || props.pendingGift || props.pendingDew)

function friendName(friend: any) {
  return String(friend?.remark || friend?.name || `好友 ${friend?.gid || ''}`)
}

function chooseDewHost(value: unknown) {
  selectedHostGid.value = String(value || '')
  emit('loadDewTargets', selectedHostGid.value)
}

function itemText(item: { name: string, id: string, count: string }) {
  return `${item.name || `物品 ${item.id}`} ×${item.count || '0'}`
}

function balanceText(count: string, known: boolean) {
  return known ? count || '0' : '--'
}
</script>

<template>
  <section class="qixi">
    <div v-if="!activity" class="empty">
      当前账号未发现进行中的鹊桥寄情活动
    </div>
    <template v-else>
      <header>
        <div><span>七夕限时活动</span><h2>{{ activity.name }}</h2><p>使用鹊羽灵露收集鹊羽，筑桥领奖并向好友赠送香囊。</p></div>
        <span class="status">{{ activity.active ? '活动进行中' : '活动已结束' }}</span>
      </header>

      <div class="inventory">
        <article v-for="item in [activity.dew, activity.feather, activity.sachet, activity.receivedSachet]" :key="item.id">
          <img v-if="item.image" :src="item.image" alt=""><span>{{ item.name || `物品 ${item.id}` }}</span><strong>{{ balanceText(item.count, activity.balances.known) }}</strong>
        </article>
      </div>

      <section class="card">
        <div class="heading">
          <div><small>土地互动</small><h3>使用鹊羽灵露</h3></div><strong>{{ balanceText(activity.dew.count, activity.dew.balanceKnown) }} 份</strong>
        </div>
        <p class="hint">
          候选地块由当前农场快照生成，最终仍由服务器校验；无效果的空回包不会计为成功。
        </p>
        <div class="control-row">
          <select :value="selectedHostGid" :disabled="busy || dewTargetsLoading" @change="chooseDewHost(($event.target as HTMLSelectElement).value)">
            <option value="">
              我的农场
            </option>
            <option v-for="friend in friends" :key="friend.gid" :value="String(friend.gid)">
              {{ friendName(friend) }}
            </option>
          </select>
          <button class="secondary" :disabled="dewTargetsLoading || busy" @click="emit('loadDewTargets', selectedHostGid)">
            {{ dewTargetsLoading ? '读取中' : '刷新地块' }}
          </button>
        </div>
        <p v-if="dewTargetsError" class="error">
          {{ dewTargetsError }}
        </p>
        <div v-else-if="dewTargetsLoading" class="placeholder">
          正在读取农场地块…
        </div>
        <div v-else-if="dewTargets" class="lands">
          <button
            v-for="land in dewTargets.lands"
            :key="land.landId"
            :disabled="busy || !activity.actions.dew.enabled"
            @click="emit('useDew', dewTargets.host.isSelf ? '' : dewTargets.host.gid, land.landId)"
          >
            <img v-if="land.seedImage" :src="land.seedImage" alt=""><span><strong>#{{ land.landId }} {{ land.plantName }}</strong><small>{{ land.phaseName }} · {{ land.mature ? '已成熟' : '生长中' }}</small></span><b>使用</b>
          </button>
          <p v-if="!dewTargets.lands.length" class="placeholder">
            当前农场没有可提交服务器校验的作物
          </p>
        </div>
      </section>

      <section class="card">
        <div class="heading">
          <div><small>筑桥进度</small><h3>消耗鹊羽筑桥</h3></div><button :disabled="busy || !activity.actions.bridge.enabled" @click="emit('claimBridge')">
            {{ pendingBridge ? '领取中' : activity.bridge.claimable ? '筑桥并领取' : '暂无可领' }}
          </button>
        </div>
        <div class="stages">
          <article v-for="stage in activity.bridge.stages" :key="stage.id" :class="{ done: stage.completed, current: stage.current }">
            <strong>第 {{ stage.stage }} 阶段</strong><small>{{ itemText(stage.cost) }}</small><span>{{ stage.claimable ? '可领取' : stage.completed ? '已完成' : '未完成' }}</span>
          </article>
        </div>
      </section>

      <section class="card">
        <div class="heading">
          <div><small>好友赠礼</small><h3>赠送鹊羽香囊</h3></div><button class="secondary" :disabled="friendsLoading" @click="emit('refreshFriends')">
            {{ friendsLoading ? '刷新中' : '刷新好友' }}
          </button>
        </div>
        <div class="control-row">
          <select v-model="selectedGiftGid" :disabled="busy || friendsLoading">
            <option value="">
              选择好友
            </option>
            <option v-for="friend in friends" :key="friend.gid" :value="String(friend.gid)">
              {{ friendName(friend) }} · GID {{ friend.gid }}
            </option>
          </select>
          <button :disabled="busy || !selectedGiftGid || !activity.actions.gift.enabled" @click="emit('gift', selectedGiftGid)">
            {{ pendingGift ? '赠送中' : '赠送 1 个' }}
          </button>
        </div>
        <p class="hint">
          已赠 {{ activity.gift.sentCount }}<template v-if="activity.gift.sendLimit !== '0'">
            / {{ activity.gift.sendLimit }}
          </template> 次
        </p>
      </section>

      <section v-if="activity.rules.paragraphs.length" class="card rules">
        <h3>{{ activity.rules.title || '活动说明' }}</h3><p v-for="line in activity.rules.paragraphs" :key="line">
          {{ line }}
        </p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.qixi {
  min-height: 100%;
  padding: 112px 14px 96px;
  color: #5b3944;
  background: linear-gradient(180deg, #f6cbd8, #fff0e7 42%, #f5dfbd);
}
.empty,
.placeholder {
  padding: 28px 12px;
  color: #8c6b73;
  text-align: center;
}
header,
.heading,
.control-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
header {
  margin-bottom: 12px;
}
header span,
header p,
small,
.hint {
  color: #8b6871;
  font-size: 11px;
}
h2 {
  margin: 2px 0;
  font-size: 27px;
}
h3 {
  margin: 2px 0;
  font-size: 16px;
}
.status {
  flex: none;
  padding: 6px 9px;
  border-radius: 999px;
  color: #99495f;
  background: #fff8;
}
.inventory {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 7px;
  margin-bottom: 10px;
}
.inventory article {
  min-width: 0;
  display: grid;
  place-items: center;
  gap: 2px;
  padding: 8px 4px;
  border: 1px solid #d9a8b2;
  border-radius: 10px;
  background: #fff9;
}
.inventory img {
  width: 34px;
  height: 34px;
  object-fit: contain;
}
.inventory span {
  max-width: 100%;
  overflow: hidden;
  color: #80616a;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.inventory strong {
  font-size: 16px;
}
.card {
  margin-bottom: 10px;
  padding: 13px;
  border: 1px solid #d6a7ae;
  border-radius: 12px;
  background: #fffffff0;
  box-shadow: 0 5px 16px #6e3f4a14;
}
.card button {
  min-height: 36px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  color: white;
  background: #a44762;
  font-weight: 700;
}
.card button.secondary {
  color: #8f4058;
  background: #f4d9df;
}
.card button:disabled {
  opacity: 0.45;
}
.hint {
  margin: 6px 0 9px;
  line-height: 1.5;
}
select {
  min-width: 0;
  height: 38px;
  flex: 1;
  padding: 0 9px;
  border: 1px solid #d6a7ae;
  border-radius: 8px;
  color: #5b3944;
  background: white;
}
.lands {
  display: grid;
  gap: 6px;
  margin-top: 9px;
}
.lands button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  color: #5b3944;
  text-align: left;
  background: #fff5f3;
  border: 1px solid #e5c4c8;
}
.lands img {
  width: 36px;
  height: 36px;
  object-fit: contain;
}
.lands span {
  min-width: 0;
  display: flex;
  flex: 1;
  flex-direction: column;
}
.lands b {
  color: #a44762;
}
.stages {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 7px;
  margin-top: 9px;
}
.stages article {
  display: flex;
  flex-direction: column;
  padding: 8px;
  border: 1px solid #e3ced0;
  border-radius: 8px;
  background: #faf4ef;
}
.stages article.done {
  background: #e8f2df;
}
.stages article.current {
  border-color: #b5546d;
  box-shadow: inset 0 0 0 1px #b5546d;
}
.stages span {
  margin-top: 4px;
  color: #a44762;
  font-size: 11px;
}
.error {
  margin: 9px 0 0;
  color: #b42945;
  font-size: 12px;
}
.rules p {
  color: #71565e;
  font-size: 12px;
  line-height: 1.65;
}
</style>
