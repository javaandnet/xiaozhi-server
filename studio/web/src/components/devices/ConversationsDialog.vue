<script setup>
import { reactive, ref } from 'vue';
import { listConversations } from '@/api/device';
import { fmtTs } from '@/composables/useFormat';
import { useApi } from '@/composables/useApi';

const visible = ref(false);
const { loading, run } = useApi();
const rows = reactive({ total: 0, items: [] });
const page = ref(1);
const filter = reactive({ deviceId: '', role: '' });

async function load(targetPage = page.value) {
  if (typeof targetPage === 'number') page.value = targetPage;
  const r = await run(() => listConversations({ deviceId: filter.deviceId, role: filter.role, page: page.value }));
  if (!r) return;
  rows.total = r.total || 0;
  rows.items = r.items || [];
}

async function open(deviceId) {
  if (!deviceId) {
    ElMessage.warning('该行没有设备ID');
    return;
  }
  filter.deviceId = deviceId;
  filter.role = '';
  page.value = 1;
  visible.value = true;
  await load(1);
}

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="visible" :title="'对话记录 · ' + filter.deviceId" width="860px" top="6vh">
    <div class="row">
      <el-select v-model="filter.role" style="width: 130px" @change="load(1)">
        <el-option value="" label="全部角色" />
        <el-option value="user" label="user" />
        <el-option value="bot" label="bot" />
      </el-select>
      <el-button size="small" @click="load(1)">⟳ 刷新</el-button>
      <span class="hint">共 {{ rows.total }} 条</span>
    </div>
    <el-table v-loading="loading" :data="rows.items" size="small" max-height="440">
      <el-table-column label="时间" width="160">
        <template #default="s">{{ fmtTs(s.row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="角色" width="80">
        <template #default="s">
          <el-tag size="small" :type="s.row.role === 'user' ? 'info' : 'success'">{{ s.row.role }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="speaker" label="说话人" width="90">
        <template #default="s">{{ s.row.speaker || '-' }}</template>
      </el-table-column>
      <el-table-column prop="text" label="内容" min-width="300" show-overflow-tooltip />
      <el-table-column prop="emotion" label="表情" width="90" />
      <el-table-column prop="provider" label="来源" width="100" />
    </el-table>
    <el-pagination
      v-model:current-page="page"
      style="margin-top: 10px"
      layout="prev, pager, next"
      :total="rows.total"
      :page-size="50"
      @current-change="load"
    />
  </el-dialog>
</template>
