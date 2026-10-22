<script setup>
import { onMounted, reactive, ref } from 'vue';
import { addUser, deleteUser, listUsers, setUserPassword } from '@/api/firmware';
import { confirmAction, useApi } from '@/composables/useApi';
import { fmtTs } from '@/composables/useFormat';

const items = ref([]);
const me = ref('');
const form = reactive({ username: '', password: '' });
const { loading, run } = useApi();

async function load() {
  const r = await run(() => listUsers());
  if (!r) return;
  items.value = r.items || [];
  me.value = r.me || '';
}

async function add() {
  const username = form.username.trim();
  if (!username || !form.password) {
    ElMessage.warning('请填写用户名和密码');
    return;
  }
  if (await run(() => addUser(username, form.password))) {
    ElMessage.success('已添加 ' + username);
    form.username = '';
    form.password = '';
    await load();
  }
}

async function resetPassword(username) {
  let password;
  try {
    const r = await ElMessageBox.prompt(`为 ${username} 设置新密码（≥6位）`, '重置密码', {
      inputType: 'password',
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    });
    password = r.value;
  } catch {
    return;
  }
  if (!password) return;
  if (await run(() => setUserPassword(username, password))) {
    ElMessage.success('密码已更新');
  }
}

async function remove(username) {
  if (!(await confirmAction(`确认删除管理员 ${username}？`, '删除确认'))) return;
  if (await run(() => deleteUser(username))) {
    ElMessage.success('已删除 ' + username);
    await load();
  }
}

onMounted(load);
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header>
      <div style="display: flex; align-items: center; gap: 10px">
        <b>⑥ 账户管理（管理员）</b>
        <el-button class="op-btn" size="small" style="margin-left: auto" :loading="loading" @click="load">
          ⟳ 刷新
        </el-button>
      </div>
    </template>
    <el-table :data="items" size="small" max-height="260">
      <el-table-column label="用户名" min-width="160">
        <template #default="s">
          {{ s.row.username }}
          <span v-if="s.row.username === me" style="color: var(--el-color-success)">（当前）</span>
        </template>
      </el-table-column>
      <el-table-column prop="role" label="角色" width="120" />
      <el-table-column label="创建者" width="160">
        <template #default="s">
          <span class="hint">{{ s.row.created_by || '-' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="200">
        <template #default="s">
          <span class="hint">{{ fmtTs(s.row.created_at) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="s">
          <el-button size="small" @click="resetPassword(s.row.username)">重置密码</el-button>
          <el-button size="small" type="danger" plain @click="remove(s.row.username)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="row" style="margin-top: 10px">
      <el-input v-model="form.username" placeholder="新管理员用户名" size="small" style="width: 200px" />
      <el-input
        v-model="form.password"
        type="password"
        placeholder="密码（≥6位）"
        size="small"
        style="width: 200px"
        show-password
        @keyup.enter="add"
      />
      <el-button size="small" type="primary" :loading="loading" @click="add">＋ 添加管理员</el-button>
    </div>
  </el-card>
</template>
