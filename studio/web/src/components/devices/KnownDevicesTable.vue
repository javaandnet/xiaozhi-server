<script setup>
import { fmtTs } from '@/composables/useFormat';
import { useRobotStatus } from '@/composables/useRobotStatus';

defineProps({
  rows: { type: Array, required: true },
});

const emit = defineEmits(['select', 'speak', 'command', 'settings', 'convs', 'remove']);

const { hwStatusFor } = useRobotStatus();
</script>

<template>
  <el-table :data="rows" size="small" max-height="560" @selection-change="(r) => emit('select', r)">
    <el-table-column type="selection" width="42" />
    <el-table-column prop="device_id" label="MAC / 设备ID" width="200">
      <template #default="s"><span class="mono">{{ s.row.device_id }}</span></template>
    </el-table-column>
    <el-table-column prop="model" label="型号" width="150">
      <template #default="s">
        <el-tag size="small" effect="plain">{{ s.row.model || '-' }}</el-tag>
      </template>
    </el-table-column>
    <el-table-column prop="firmware_version" label="固件" width="90" />
    <el-table-column label="在线" width="70">
      <template #default="s">
        <el-tag v-if="Number(s.row.online) && Number(s.row.rest)" type="warning" size="small">休息</el-tag>
        <el-tag v-else-if="Number(s.row.online)" type="success" size="small">在线</el-tag>
        <span v-else class="hint">离线</span>
      </template>
    </el-table-column>
    <el-table-column label="机器人硬件" width="140">
      <template #default="s">
        <el-tag v-if="hwStatusFor(s.row)" :type="hwStatusFor(s.row).type" size="small">
          {{ hwStatusFor(s.row).text }}
        </el-tag>
        <span v-else class="hint">—</span>
      </template>
    </el-table-column>
    <el-table-column label="家居" width="70">
      <template #default="s">
        <el-tag v-if="Number(s.row.home)" type="success" size="small" effect="plain">🏠已开</el-tag>
        <span v-else class="hint">—</span>
      </template>
    </el-table-column>
    <el-table-column prop="ip" label="IP" width="130">
      <template #default="s"><span class="mono">{{ s.row.ip || '-' }}</span></template>
    </el-table-column>
    <el-table-column prop="connect_count" label="连接次数" width="90" />
    <el-table-column label="最近连接" min-width="160">
      <template #default="s">{{ fmtTs(s.row.last_seen) }}</template>
    </el-table-column>
    <el-table-column label="首次接入" min-width="160">
      <template #default="s">{{ fmtTs(s.row.first_seen) }}</template>
    </el-table-column>
    <el-table-column label="语音广播" width="100" align="center">
      <template #default="s">
        <el-button class="op-btn" size="small" type="primary" plain @click="emit('speak', s.row)">📢广播</el-button>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="340" fixed="right">
      <template #default="s">
        <el-button
          class="op-btn"
          size="small"
          type="success"
          plain
          @click="emit('command', { device: s.row.device_id, label: s.row.device_name || s.row.device_id, kind: 'voice' })"
        >
          🛠指令
        </el-button>
        <el-button class="op-btn" size="small" type="primary" plain @click="emit('settings', s.row.device_id)">
          ⚙设定
        </el-button>
        <el-button class="op-btn" size="small" plain @click="emit('convs', s.row.device_id)">💬记录</el-button>
        <el-button class="op-btn" size="small" type="danger" plain @click="emit('remove', s.row)">🗑删除</el-button>
      </template>
    </el-table-column>
  </el-table>
</template>
