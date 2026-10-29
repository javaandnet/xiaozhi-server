<script setup>
/**
 * 看家(watch)模式子面板：变化事件列表（时间+变化度+快照缩略图，点击看大图）
 * 与语音播报开关（默认关；开启后家里实例轮询事件并向在线小智设备播报）。
 * 事件/快照都存派上，经主通道端点读取——外出时整条链路经 peer 转发家里。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { getWatchEventsXz, getAnnounceXz, setAnnounceXz } from '@/api/mcp';
import { NS } from '@/api/http';

const events = ref([]);
const loading = ref(false);
const announce = ref(false);
const announceLoading = ref(false);
const bigShot = ref('');

// 画面源双路口径与 useFaceStream 一致：hub（外出）快照走云端专用通道，本地直连主通道
function shotUrl(name) {
  return name ? `${NS}/api/masterpi/stream/watch/shot?name=${encodeURIComponent(name)}` : '';
}

async function loadEvents() {
  loading.value = true;
  try {
    const r = await getWatchEventsXz(0);
    // 最新在前；快照只留 20 张，更早事件的 shot 可能已滚动删除（图裂由 @error 隐藏）
    events.value = (r.events || []).slice().sort((a, b) => b.ts - a.ts);
  } catch (e) {
    console.warn('[watch] events load failed:', e.message);
  } finally {
    loading.value = false;
  }
}

async function loadAnnounce() {
  try {
    const r = await getAnnounceXz();
    if (r && r.ok) announce.value = !!r.announce;
  } catch { /* best effort */ }
}

async function toggleAnnounce(val) {
  announceLoading.value = true;
  try {
    const r = await setAnnounceXz(val);
    if (r && r.ok) {
      announce.value = !!r.announce;
      ElMessage.success(val ? '已开启：检测到变化时将播报' : '已关闭播报');
    } else {
      announce.value = !val;
      ElMessage.error((r && r.error) || '设置失败');
    }
  } catch (e) {
    announce.value = !val;
    ElMessage.error(String(e?.message || e));
  } finally {
    announceLoading.value = false;
  }
}

function fmtEventTs(ts) {
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
}

const hasEvents = computed(() => events.value.length > 0);
const bigShotVisible = computed({ get: () => !!bigShot.value, set: (v) => { if (!v) bigShot.value = ''; } });

let timer = null;
onMounted(() => {
  loadEvents();
  loadAnnounce();
  timer = setInterval(loadEvents, 15000); // 事件低频，15s 轮询足够
});
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

defineExpose({ reload: loadEvents });
</script>

<template>
  <div class="watch-panel">
    <div class="row">
      <b>🏠 看家事件</b>
      <span class="hint">灰度差帧判定画面变化（冷却 60s 防连发），快照滚动保留 20 张</span>
      <el-button size="small" text :loading="loading" @click="loadEvents">⟳ 刷新</el-button>
      <span style="flex: 1" />
      <span class="hint">语音播报</span>
      <el-switch
        v-model="announce"
        size="small"
        :loading="announceLoading"
        @change="toggleAnnounce"
      />
    </div>
    <div v-if="!hasEvents" class="hint" style="margin-top: 8px">暂无变化事件（画面稳定时不产生事件）</div>
    <div v-else class="events">
      <div v-for="(ev, i) in events" :key="ev.ts + '-' + i" class="event">
        <img
          v-if="ev.shot"
          :src="shotUrl(ev.shot)"
          :alt="ev.shot"
          class="thumb"
          @click="bigShot = shotUrl(ev.shot)"
          @error="$event.target.style.visibility = 'hidden'"
        />
        <div v-else class="thumb placeholder">无图</div>
        <div class="meta">
          <div>{{ fmtEventTs(ev.ts) }}</div>
          <div class="hint">变化度 {{ (ev.ratio * 100).toFixed(1) }}%</div>
        </div>
      </div>
    </div>
    <el-dialog v-model="bigShotVisible" width="auto" title="快照">
      <img :src="bigShot" style="max-width: 80vw" alt="shot" />
    </el-dialog>
  </div>
</template>

<style scoped>
.watch-panel {
  border-top: 1px dashed var(--el-border-color);
  margin-top: 10px;
  padding-top: 10px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.events {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  margin-top: 10px;
  padding-bottom: 4px;
}
.event {
  width: 168px;
  flex: none;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  overflow: hidden;
}
.thumb {
  width: 166px;
  height: 100px;
  object-fit: cover;
  cursor: pointer;
  display: block;
  background: #111;
}
.thumb.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  cursor: default;
}
.meta {
  padding: 4px 6px;
  font-size: 12px;
  line-height: 1.5;
}
</style>
