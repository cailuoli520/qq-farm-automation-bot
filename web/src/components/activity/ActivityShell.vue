<script setup lang="ts">
defineProps<{ theme?: 'night' | 'day' | 'rain' }>()
</script>

<template>
  <section class="activity-shell" :class="`activity-shell--${theme || 'night'}`" data-theme-exempt>
    <div class="activity-shell__stars" aria-hidden="true" />
    <div class="activity-shell__frame">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.activity-shell {
  position: fixed;
  z-index: 50;
  inset: 0;
  overflow: hidden;
  color: #f8fbff;
  background: #102758;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
  isolation: isolate;
}
.activity-shell--night {
  background:
    radial-gradient(circle at 75% 20%, rgba(83, 142, 225, 0.38), transparent 25%),
    linear-gradient(180deg, #152958 0%, #075a91 52%, #087bb0 100%);
}
.activity-shell--day {
  background: linear-gradient(180deg, #50bde9, #9dddf2 50%, #83c866);
}
.activity-shell--rain {
  background:
    radial-gradient(circle at 18% 8%, rgba(186, 230, 255, 0.9), transparent 30%),
    radial-gradient(circle at 88% 72%, rgba(189, 224, 208, 0.72), transparent 34%),
    linear-gradient(180deg, #dbe8f0 0%, #eef3f5 48%, #dfe9e1 100%);
}
.activity-shell__stars {
  position: absolute;
  inset: 0;
  opacity: 0.55;
  pointer-events: none;
  background-image:
    radial-gradient(circle, #fff 0 1px, transparent 1.6px), radial-gradient(circle, #ffe976 0 1.4px, transparent 2px);
  background-position:
    17px 23px,
    53px 71px;
  background-size:
    71px 83px,
    109px 127px;
}
.activity-shell--day .activity-shell__stars {
  opacity: 0.12;
}
.activity-shell--rain .activity-shell__stars {
  opacity: 0.13;
  background-image: repeating-linear-gradient(
    112deg,
    transparent 0 20px,
    rgba(71, 126, 153, 0.5) 21px 22px,
    transparent 23px 43px
  );
  animation: rain-drift 2.4s linear infinite;
}
.activity-shell__frame {
  position: relative;
  z-index: 1;
  width: min(100%, 455px);
  height: 100%;
  margin: 0 auto;
  overflow: hidden;
  background: rgba(0, 34, 86, 0.08) url('/activity-center/stellar/night-background.png') center/cover no-repeat;
  box-shadow: 0 0 44px rgba(0, 18, 55, 0.4);
}
.activity-shell--day .activity-shell__frame {
  background: rgba(120, 200, 110, 0.08);
}
.activity-shell--rain .activity-shell__frame {
  background: rgba(242, 242, 247, 0.28);
  box-shadow: 0 0 44px rgba(44, 62, 76, 0.16);
}
.activity-shell--rain :deep(.activity-header) {
  background: linear-gradient(180deg, rgba(245, 249, 252, 0.9), rgba(245, 249, 252, 0.56) 72%, transparent);
  text-shadow: none;
}
.activity-shell--rain :deep(.activity-header__back),
.activity-shell--rain :deep(.activity-header h1) {
  color: #1d1d1f;
  filter: none;
}
.activity-shell--rain :deep(.activity-header__refresh) {
  border-color: rgba(0, 122, 255, 0.16);
  color: #007aff;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}
.activity-shell--rain :deep(.activity-header__time) {
  color: #3a3a3c;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.07);
}
@keyframes rain-drift {
  to {
    background-position: 26px 42px;
  }
}
@media (min-width: 700px) {
  .activity-shell {
    padding: 12px 0;
  }
  .activity-shell__frame {
    height: calc(100% - 24px);
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 22px;
  }
}
</style>
