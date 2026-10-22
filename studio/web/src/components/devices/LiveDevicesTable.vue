<script setup>
import { cell } from '@/composables/useFormat';

defineProps({
  rows: { type: Array, required: true },
  columns: { type: Array, required: true },
});

const emit = defineEmits(['speak', 'command', 'wake', 'settings', 'convs', 'detail', 'disconnect']);
</script>

<template>
  <el-table :data="rows" size="small" max-height="480">
    <el-table-column v-for="c in columns" :key="c" :prop="c" :label="c" min-width="140" show-overflow-tooltip>
      <template #default="s"><span class="mono">{{ cell(s.row[c]) }}</span></template>
    </el-table-column>
    <el-table-column label="操作" width="560" fixed="right">
      <template #default="s">
        <el-button class="op-btn" size="small" type="primary" plain @click="emit('speak', s.row)">发语音</el-button>
        <el-button
          class="op-btn"
          size="small"
          type="success"
          plain
          @click="
            emit('command', {
              device: s.row.clientId || s.row.deviceId,
              label: s.row.deviceName || s.row.deviceId || s.row.clientId,
              kind: 'voice',
            })
          "
        >
          🛠指令
        </el-button>
        <el-button class="op-btn" size="small" type="warning" plain @click="emit('wake', s.row)">🔔唤醒</el-button>
        <el-button
          class="op-btn"
          size="small"
          type="primary"
          plain
          @click="emit('settings', s.row.deviceId || s.row.clientId)"
        >
          ⚙设定
        </el-button>
        <el-button class="op-btn" size="small" plain @click="emit('convs', s.row.deviceId || s.row.clientId)">
          💬记录
        </el-button>
        <el-button class="op-btn" size="small" @click="emit('detail', s.row)">详情</el-button>
        <el-button class="op-btn" size="small" type="danger" plain @click="emit('disconnect', s.row)">断开</el-button>
      </template>
    </el-table-column>
  </el-table>
  <el-empty v-if="!rows.length" description="当前没有设备在线" />
</template>
