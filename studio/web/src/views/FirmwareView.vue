<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useEnv } from '@/composables/useEnv';
import { useFirmware } from '@/composables/useFirmware';
import { useRefreshBus } from '@/composables/useRefreshBus';
import InstalledFirmwareTable from '@/components/firmware/InstalledFirmwareTable.vue';
import UsbFlashCard from '@/components/firmware/UsbFlashCard.vue';
import WebSerialFlashCard from '@/components/firmware/WebSerialFlashCard.vue';
import AccountsCard from '@/components/firmware/AccountsCard.vue';

const { env, load: loadEnv } = useEnv();
const {
  devices,
  boards,
  boardFilter,
  boardSel,
  boardOptions,
  boardMeta,
  rel,
  relBehind,
  portSel,
  flashSize,
  logLines,
  artifact,
  detectHint,
  syncRef,
  ww,
  flags,
  push,
  loadBoards,
  loadFirmware,
  detect,
  checkRelease,
  loadSyncDefault,
  sync,
  build,
  stopWatching,
  install,
  openEvents,
} = useFirmware();
const { register, unregister } = useRefreshBus();

const logEl = ref(null);

watch(
  () => logLines.value.length,
  () => {
    nextTick(() => {
      if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
    });
  },
);

async function reload() {
  await Promise.all([loadEnv(), loadBoards(), loadFirmware()]);
}

onMounted(async () => {
  openEvents();
  await Promise.all([loadEnv(), loadBoards(), loadFirmware(), loadSyncDefault()]);
  if (!env.allOk) push(logLines, '⚠ 环境检查有缺失项（见顶部红叉），编译可能失败。', 'warn');
  if (env.ports?.length && !portSel.value) portSel.value = env.ports[0];
  detect().catch(() => {
    /* detection is a convenience: the board can always be picked by hand */
  });
  register(reload);
});

onBeforeUnmount(unregister);
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header><b>① 自动识别设备 / 板型</b></template>
    <div class="row">
      <el-button type="primary" :loading="flags.detecting" @click="detect">⟳ 检测最近连接的设备</el-button>
      <span class="hint">{{ detectHint }}</span>
    </div>
    <el-table v-if="devices.length" :data="devices" size="small" max-height="220">
      <el-table-column label="设备ID">
        <template #default="s"><span class="mono">{{ s.row.device_id }}</span></template>
      </el-table-column>
      <el-table-column prop="model" label="型号" width="160" />
      <el-table-column prop="firmware_version" label="固件" width="100" />
      <el-table-column label="状态" width="80">
        <template #default="s">
          <el-tag v-if="Number(s.row.online)" type="success" size="small">在线</el-tag>
          <span v-else class="hint">离线</span>
        </template>
      </el-table-column>
      <el-table-column prop="last_seen" label="最近连接" width="180" />
    </el-table>
  </el-card>

  <el-card class="card" shadow="never">
    <template #header><b>② 选择板型 &amp; 核对版本</b></template>
    <div class="row">
      <el-input
        v-model="boardFilter"
        placeholder="关键字过滤，如 xmini / lichuang（共 {{ boards.length }} 个变体）"
        clearable
        style="max-width: 420px"
      />
    </div>
    <div class="row">
      <el-select v-model="boardSel" filterable placeholder="选择板型" style="min-width: 340px">
        <el-option v-for="b in boardOptions" :key="b.value" :value="b.value" :label="b.label" />
      </el-select>
      <span class="hint mono">{{ boardMeta }}</span>
      <el-button :loading="flags.checking" @click="checkRelease">查官方最新版</el-button>
    </div>
    <div class="hint" style="margin-bottom: 10px">
      本地仓库版本 <b class="mono">{{ env.repoVersion || '?' }}</b>
      <template v-if="rel">｜官方最新 <b class="mono">{{ rel.latest || '?' }}</b></template>
      <el-tag v-if="rel && !rel.error && relBehind" size="small" type="warning">本地落后，可先 git 切 tag 再编译</el-tag>
      <el-tag v-else-if="rel && !rel.error" size="small" type="success">本地为最新或更新</el-tag>
      <span v-if="rel && !rel.error && rel.zipForBoard">｜官方有该板型预编译包（仅整片镜像，不能用于 OTA）</span>
      <span v-if="rel && rel.error" class="hint">官方版本查询失败：{{ rel.error }}</span>
    </div>
    <div class="row">
      <span class="hint">同步源码</span>
      <el-input v-model="syncRef" placeholder="官方最新 tag 已预填；留空 = git pull" style="max-width: 300px" />
      <el-button :loading="flags.syncing" @click="sync">⬇ git 拉取 / 切 tag</el-button>
    </div>
  </el-card>

  <el-card class="card" shadow="never">
    <template #header><b>③ 编译（build.py 权威构建 → 注入私有 OTA 地址 → 纯 app 镜像）</b></template>
    <div class="row">
      <span class="hint">主 OTA 地址</span>
      <el-input v-model="env.otaUrl" style="max-width: 480px" />
    </div>
    <div class="row">
      <span class="hint">备用 OTA 地址</span>
      <div style="flex: 1; max-width: 480px">
        <el-input
          v-model="env.otaUrlFallback"
          placeholder="留空 = 不启用；如 http://你的网络服务器:8003/xiaozhi/ota/"
        />
        <div class="hint">
          主地址连不上（开发机关机/断网）时设备自动改用备用地址。需固件含 OTA 双地址补丁（本仓库源码已打，编译即带）。
        </div>
      </div>
    </div>
    <div class="row">
      <span class="hint">Flash 容量</span>
      <el-select v-model="flashSize" style="width: 230px">
        <el-option label="16MB（官方标准）" value="16MB" />
        <el-option label="8MB（v2/8m 分区表）" value="8MB" />
      </el-select>
      <span class="hint">按芯片实际 flash 容量选择，错了会导致 assets 分区写不下</span>
    </div>
    <div class="row">
      <span class="hint">唤醒词</span>
      <el-select v-model="ww.mode" style="width: 230px">
        <el-option label="固件内置（不注入）" value="default" />
        <el-option label="自定义 · Multinet（仅 S3/P4）" value="custom" />
      </el-select>
    </div>
    <div v-if="ww.mode === 'custom'" class="row" style="align-items: flex-start">
      <span class="hint">自定义唤醒词</span>
      <div style="flex: 1; max-width: 540px">
        <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center">
          <el-input v-model="ww.word" placeholder="拼音空格分隔: ni hao xiao dou" style="width: 220px" />
          <el-input v-model="ww.display" placeholder="显示名(可选): 你好小豆" style="width: 150px" />
          <span class="hint">灵敏度(越小越灵敏)</span>
          <el-input-number v-model="ww.threshold" :min="1" :max="99" size="small" />
        </div>
        <div class="hint">
          仅 ESP32-S3/P4/S31（带 PSRAM）支持；C3/C5/C6 不可自定义（只能换乐鑫预置模型，详见固件仓库
          GALA-WAKEWORD.md）。拼音留空 = 不注入。
        </div>
      </div>
    </div>
    <div class="row">
      <el-button type="success" :disabled="flags.building" @click="build">▶ 开始编译</el-button>
      <el-button :disabled="!flags.building" @click="stopWatching">停止跟踪（后台继续）</el-button>
      <span class="hint">首次编译约数分钟，之后增量。</span>
    </div>
    <pre ref="logEl" class="log"><div v-for="(l, i) in logLines" :key="i" :class="l.c">{{ l.t }}</div><div v-if="!logLines.length">编译日志将显示在这里…</div></pre>
    <div v-if="artifact" class="row" style="margin-top: 12px">
      <span style="color: var(--el-color-success)">
        产物就绪：{{ artifact.type }} {{ artifact.version }}（纯 app 镜像）
      </span>
      <el-button type="primary" :loading="flags.installing" @click="install()">📦 安装到 OTA 目录（data/bin）</el-button>
    </div>
  </el-card>

  <InstalledFirmwareTable />

  <UsbFlashCard />

  <WebSerialFlashCard />

  <AccountsCard />
</template>
