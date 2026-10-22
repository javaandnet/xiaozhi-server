<script setup>
import { useEnv } from '@/composables/useEnv';
import { useFirmware } from '@/composables/useFirmware';

const { env } = useEnv();
const { portSel, flashLines, flags, refreshPorts, flash } = useFirmware();
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header><b>④ USB 直接烧录（可选 · 危险）</b></template>
    <div class="row">
      <span class="hint">串口</span>
      <el-select v-model="portSel" placeholder="选择串口" style="min-width: 260px">
        <el-option v-for="p in env.ports" :key="p" :value="p" :label="p" />
      </el-select>
      <el-button class="op-btn" size="small" @click="refreshPorts">⟳</el-button>
      <el-button type="danger" :loading="flags.flashing" @click="flash">🔥 烧录当前 build 到设备</el-button>
    </div>
    <div class="hint">烧录前需已完成一次编译；设备需处于可烧录态。会改写设备固件，请确认型号无误。</div>
    <pre v-if="flags.flashing || flashLines.length" class="log" style="height: 200px"><div v-for="(l, i) in flashLines" :key="i" :class="l.c">{{ l.t }}</div></pre>
  </el-card>
</template>
