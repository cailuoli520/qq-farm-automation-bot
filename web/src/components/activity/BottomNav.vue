<script setup lang="ts">
import type { ActivityTabDefinition } from '@/features/activity-center/registry'
import type { ActivityTabKey } from '@/features/activity-center/types'

export type ActivityTab = ActivityTabKey

const props = withDefaults(defineProps<{
  modelValue: ActivityTab
  badges?: Partial<Record<ActivityTab, boolean>>
  items: readonly ActivityTabDefinition[]
}>(), { badges: () => ({}) })

defineEmits<{
  'update:modelValue': [value: ActivityTab]
}>()
</script>

<template>
  <nav
    class="activity-nav"
    aria-label="活动页面"
    :data-theme="props.items.every(item => item.theme === 'rain') ? 'rain' : undefined"
    :style="{ gridTemplateColumns: `repeat(${Math.max(1, props.items.length)}, minmax(0, 1fr))` }"
  >
    <button
      v-for="item in props.items"
      :key="item.key"
      type="button"
      :class="`activity-nav__item--${item.key}`"
      :aria-label="badges[item.key] && item.theme === 'rain' ? `${item.label}，有可操作内容` : item.label"
      :aria-current="modelValue === item.key ? 'page' : undefined"
      :data-active="modelValue === item.key || undefined"
      @click="$emit('update:modelValue', item.key)"
    >
      <span class="activity-nav__visual">
        <span v-if="item.key === 'qingmei'" class="activity-nav__qingmei" aria-hidden="true">🍶</span>
        <span v-else-if="item.key === 'qixi'" class="activity-nav__qixi" aria-hidden="true">🌉</span>
        <span v-else-if="item.key === 'rainTasks'" class="activity-nav__rain" aria-hidden="true">🌧️</span>
        <span v-else-if="item.key === 'rainResearch'" class="activity-nav__rain" aria-hidden="true">⚡</span>
        <img v-else :src="`/activity-center/stellar/nav-${item.key}.png`" alt="">
        <span v-if="badges[item.key] && item.theme === 'rain'" class="activity-nav__badge-label" aria-hidden="true">可操作</span>
        <i v-else-if="badges[item.key]" class="activity-nav__badge" aria-label="有可操作内容" />
      </span>
      <span v-if="item.theme === 'rain'" class="activity-nav__label">{{ item.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.activity-nav {
  position: absolute;
  z-index: 30;
  inset: auto 0 0;
  height: calc(72px + env(safe-area-inset-bottom));
  padding: 1px 7px env(safe-area-inset-bottom);
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-top: 2px solid rgba(132, 220, 252, 0.68);
  background: #326ba3 url('/activity-center/stellar/nav-background.png') center top / 100% 100% no-repeat;
  box-shadow:
    0 -7px 18px rgba(2, 35, 80, 0.3),
    inset 0 2px rgba(255, 255, 255, 0.12);
}

button {
  --nav-image-offset-x: 0px;
  --nav-image-offset-y: 0px;
  --nav-image-width: 58px;
  position: relative;
  min-width: 0;
  display: grid;
  place-items: start center;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.activity-nav__item--travel {
  --nav-image-width: 54px;
  --nav-image-offset-y: 7px;
}
.activity-nav__item--constellation {
  --nav-image-width: 68px;
  --nav-image-offset-y: -10px;
}
.activity-nav__item--shop {
  --nav-image-width: 53px;
  --nav-image-offset-y: 8px;
}
.activity-nav__item--solar {
  --nav-image-width: 48px;
  --nav-image-offset-y: 7px;
}
.activity-nav__item--qingmei {
  --nav-image-offset-y: 7px;
}
.activity-nav__item--qixi {
  --nav-image-offset-y: 7px;
}
.activity-nav__qingmei {
  margin-top: 8px;
  font-size: 38px;
  line-height: 1;
  filter: drop-shadow(0 2px 3px rgba(25, 71, 45, 0.45));
}
.activity-nav__qixi {
  margin-top: 8px;
  font-size: 36px;
  line-height: 1;
  filter: drop-shadow(0 2px 3px rgba(83, 42, 74, 0.45));
}
.activity-nav__rain {
  margin-top: 6px;
  font-size: 30px;
  line-height: 1;
  filter: drop-shadow(0 2px 3px rgba(20, 66, 78, 0.55));
}
.activity-nav__label {
  position: absolute;
  right: 4px;
  bottom: 5px;
  left: 4px;
  overflow: hidden;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 1;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-nav__visual {
  position: relative;
  width: min(100%, 72px);
  height: 68px;
  display: grid;
  place-items: start center;
}

.activity-nav__visual::before {
  content: '';
  position: absolute;
  z-index: -1;
  top: 5px;
  left: 50%;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 246, 153, 0.64), rgba(72, 159, 207, 0.08) 70%);
  opacity: 0;
  transform: translateX(-50%) scale(0.88);
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.activity-nav__visual img {
  width: var(--nav-image-width);
  max-width: 100%;
  height: auto;
  object-fit: contain;
  transform: translate(var(--nav-image-offset-x), var(--nav-image-offset-y));
  transform-origin: center center;
  transition:
    filter 0.16s ease,
    transform 0.16s ease;
}

button[data-active] .activity-nav__visual::before {
  opacity: 1;
  transform: translateX(-50%) scale(1);
}

button[data-active] .activity-nav__visual img {
  filter: drop-shadow(0 0 6px rgba(255, 239, 129, 0.8));
  transform: translate(var(--nav-image-offset-x), var(--nav-image-offset-y)) scale(1.05);
}

.activity-nav__badge {
  position: absolute;
  top: 1px;
  left: calc(50% + 20px);
  width: 10px;
  height: 10px;
  border: 1px solid white;
  border-radius: 50%;
  background: #ff4058;
  box-shadow: 0 1px 4px rgba(120, 0, 15, 0.55);
}
.activity-nav__badge-label {
  position: absolute;
  top: 0;
  left: calc(50% + 7px);
  padding: 2px 5px;
  border: 1px solid rgba(255, 255, 255, 0.9);
  border-radius: 999px;
  color: #d92d20;
  background: #fff0ef;
  box-shadow: 0 1px 5px rgba(120, 0, 15, 0.14);
  font-size: 8px;
  font-style: normal;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.activity-nav[data-theme='rain'] {
  height: calc(68px + env(safe-area-inset-bottom));
  padding: 3px 8px env(safe-area-inset-bottom);
  border-top: 1px solid rgba(60, 60, 67, 0.16);
  background: rgba(248, 250, 252, 0.86);
  box-shadow: 0 -10px 30px rgba(28, 45, 59, 0.08);
  backdrop-filter: saturate(180%) blur(24px);
}
.activity-nav[data-theme='rain'] button {
  color: #8e8e93;
}
.activity-nav[data-theme='rain'] button[data-active] {
  color: #007aff;
}
.activity-nav[data-theme='rain'] .activity-nav__visual {
  height: 45px;
}
.activity-nav[data-theme='rain'] .activity-nav__visual::before {
  top: 2px;
  width: 40px;
  height: 40px;
  background: rgba(0, 122, 255, 0.1);
}
.activity-nav[data-theme='rain'] .activity-nav__rain {
  filter: grayscale(1) opacity(0.64);
  transition: filter 0.16s ease, transform 0.16s ease;
}
.activity-nav[data-theme='rain'] button[data-active] .activity-nav__rain {
  filter: none;
  transform: scale(1.06);
}
</style>
