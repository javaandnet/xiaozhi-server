<script setup>
import { reactive, ref } from 'vue';
import { login } from '@/api/studio';

const props = defineProps({
  redirectTo: { type: String, required: true },
});

const formRef = ref(null);
const busy = ref(false);
const error = ref('');
const form = reactive({ username: 'admin', password: '' });

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

async function submit() {
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await login({ username: form.username.trim(), password: form.password });
    if (r.ok) {
      location.href = props.redirectTo;
      return;
    }
    error.value = r.error || '登录失败';
  } catch (e) {
    error.value = '请求失败：' + e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <el-card class="login-box" shadow="never">
    <template #header>
      <div class="login-title">小智服务器控制台</div>
      <div class="hint">请使用管理员账号登录</div>
    </template>
    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent="submit">
      <el-form-item label="用户名" prop="username">
        <el-input v-model="form.username" autocomplete="username" placeholder="admin" />
      </el-form-item>
      <el-form-item label="密码" prop="password">
        <el-input
          v-model="form.password"
          type="password"
          autocomplete="current-password"
          show-password
          placeholder="请输入密码"
          @keyup.enter="submit"
        />
      </el-form-item>
      <el-alert v-show="error" :title="error" type="error" :closable="false" show-icon style="margin-bottom: 12px" />
      <el-button type="primary" :loading="busy" style="width: 100%" @click="submit">登 录</el-button>
    </el-form>
  </el-card>
</template>

<style scoped>
.login-box {
  width: 340px;
  border-radius: 10px;
}

.login-title {
  font-size: 16px;
  font-weight: 700;
}
</style>
