<script setup>
import { useFirmware } from '@/composables/useFirmware';
import { fmtTs, mb } from '@/composables/useFormat';

const { fwList, fwDir, loadFirmware, removeFirmware } = useFirmware();
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header>
      <div style="display: flex; align-items: center; gap: 10px">
        <b>✓ 已安装固件</b>
        <span class="hint mono">{{ fwDir }}</span>
        <el-button class="op-btn" size="small" style="margin-left: auto" @click="loadFirmware">⟳ 刷新</el-button>
      </div>
    </template>
    <div class="hint" style="margin-bottom: 6px">
      设备下次连上 OTA（<code>/xiaozhi/ota/</code>）时，若此处有型号匹配且版本更高的固件即自动升级。
    </div>
    <el-table :data="fwList" size="small" max-height="260">
      <el-table-column label="文件">
        <template #default="s"><span class="mono">{{ s.row.filename }}</span></template>
      </el-table-column>
      <el-table-column prop="model" label="型号" width="150" />
      <el-table-column prop="version" label="版本" width="100" />
      <el-table-column label="大小" width="90">
        <template #default="s">{{ mb(s.row.size) }} MB</template>
      </el-table-column>
      <el-table-column label="时间" width="180">
        <template #default="s">{{ fmtTs(s.row.mtime) }}</template>
      </el-table-column>
      <el-table-column label="" width="80">
        <template #default="s">
          <el-button size="small" type="danger" plain @click="removeFirmware(s.row.filename)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>
