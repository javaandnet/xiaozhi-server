<script setup>
import { nextTick, onMounted, ref, watch } from 'vue';
import { ESPLoader, Transport } from 'esptool-js';
import { firmwareDownloadUrl } from '@/api/firmware';
import { getFirmwareList } from '@/api/studio';
import { confirmAction } from '@/composables/useApi';

const BAUDS = ['115200', '921600', '2000000'];

const baud = ref('115200');
const chip = ref('未连接');
const connected = ref(false);
const connecting = ref(false);
const busy = ref(false);
const files = ref([]);
const file = ref('');
const eraseAll = ref(false);
const lines = ref([]);
const logEl = ref(null);

let esp = null;

function log(text) {
  lines.value.push(text);
  if (lines.value.length > 2000) lines.value.shift();
}

watch(
  () => lines.value.length,
  () => {
    nextTick(() => {
      if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
    });
  },
);

async function loadFiles() {
  try {
    const d = await getFirmwareList();
    files.value = d.items || [];
    if (!file.value && files.value.length) file.value = files.value[0].filename;
  } catch (e) {
    log('✗ 固件列表加载失败：' + e.message);
  }
}

async function connect() {
  if (!('serial' in navigator)) {
    log('当前浏览器不支持 Web Serial（请用 Chrome / Edge）');
    return;
  }
  connecting.value = true;
  try {
    const port = await navigator.serial.requestPort();
    esp = new ESPLoader({ transport: new Transport(port), baudrate: Number(baud.value) });
    log('连接中…（设备需处于下载模式，无则按住BOOT上电）');
    const name = await esp.main();
    chip.value = name;
    connected.value = true;
    log('✓ 已连接：' + name);
  } catch (e) {
    esp = null;
    connected.value = false;
    log('✗ 连接失败：' + (e?.message || e));
  } finally {
    connecting.value = false;
  }
}

async function flash() {
  if (!esp || busy.value) return;
  if (!file.value) {
    log('请先选择固件');
    return;
  }
  if (!(await confirmAction(`确认把 ${file.value} 整片烧录到 0x0？会改写设备当前固件。`, '浏览器烧录确认'))) {
    return;
  }
  busy.value = true;
  try {
    log(`下载 ${file.value} …`);
    const resp = await fetch(firmwareDownloadUrl(file.value));
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = new Uint8Array(await resp.arrayBuffer());
    log(`烧录 ${(buf.length / 1048576).toFixed(2)}MB → 地址 0x0（进度每5%一行）`);
    let lastPct = -5;
    await esp.writeFlash({
      fileArray: [{ data: buf, address: 0x0 }],
      flashMode: 'keep',
      flashFreq: 'keep',
      flashSize: 'detect',
      eraseAll: eraseAll.value,
      compress: true,
      reportProgress: (idx, written, total) => {
        const pct = Math.floor((written / total) * 20) * 5;
        if (pct > lastPct) {
          lastPct = pct;
          log('进度 ' + pct + '%');
        }
      },
    });
    await esp.after('hard_reset');
    log('✓ 烧录完成，设备已复位');
  } catch (e) {
    log('✗ 烧录失败：' + (e?.message || e));
  } finally {
    busy.value = false;
  }
}

onMounted(loadFiles);
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header><b>⑤ 浏览器串口烧录（Web Serial · 本机USB直刷，不经服务器）</b></template>
    <div class="row">
      <span class="hint">波特率</span>
      <el-select v-model="baud" size="small" style="width: 130px" :disabled="connected">
        <el-option v-for="b in BAUDS" :key="b" :value="b" :label="b" />
      </el-select>
      <el-button size="small" :loading="connecting" @click="connect">🔌 连接串口</el-button>
      <span class="hint">{{ chip }}</span>
    </div>
    <div class="row" style="margin-top: 8px">
      <span class="hint">固件</span>
      <el-select v-model="file" filterable placeholder="选择服务器固件库中的镜像" style="min-width: 320px">
        <el-option v-for="f in files" :key="f.filename" :value="f.filename" :label="f.filename" />
      </el-select>
      <el-button size="small" type="danger" :disabled="!connected" :loading="busy" @click="flash">
        🔥 浏览器烧录
      </el-button>
      <el-checkbox v-model="eraseAll" size="small">全片擦除</el-checkbox>
    </div>
    <div class="hint">
      页面需跑在 HTTPS（或 localhost）下；用 Chrome/Edge。选择服务器固件库中的镜像后直接刷到本机 USB 上的设备，写地址
      0x0（整片合并镜像）。
    </div>
    <pre ref="logEl" class="log" style="height: 160px">{{ lines.join('\n') }}</pre>
  </el-card>
</template>
