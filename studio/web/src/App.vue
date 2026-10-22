<script setup>
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { useEnv } from '@/composables/useEnv';
import { refreshCurrentView } from '@/composables/useRefreshBus';

const route = useRoute();
const router = useRouter();

const menus = [
  { index: 'overview', label: '📊 总览' },
  { index: 'devices', label: '📱 设备管理' },
  { index: 'firmware', label: '🔧 固件工作台' },
  { index: 'masterpi', label: '🤖 MasterPi 连接' },
  { index: 'home', label: '🏠 家庭设备' },
  { index: 'interfaces', label: '🔌 接口管理' },
];
const checkNames = {
  repoDir: '仓库',
  idfExport: 'ESP-IDF',
  idfPython: 'Python',
  dataBinDir: '安装目录',
  deviceDb: '设备库',
  llmBridge: 'LLM·aibridge',
  funasr: 'STT·FunASR',
};

const { env, load: loadEnv } = useEnv();
const refreshing = ref(false);
const port = ref(location.port || '?');

async function reload() {
  refreshing.value = true;
  try {
    await Promise.all([loadEnv(), refreshCurrentView()]);
    ElMessage.success('已刷新');
  } finally {
    refreshing.value = false;
  }
}

function go(index) {
  router.push(`/${index}`);
}

onMounted(loadEnv);
</script>

<template>
  <el-config-provider :locale="zhCn">
    <el-container class="lay">
      <el-aside width="200px" class="aside">
        <div class="logo">
          🎙️ 小智服务器<small>独立运行版控制台</small>
        </div>
        <el-menu :default-active="String(route.name)" style="flex: 1" @select="go">
          <el-menu-item v-for="m in menus" :key="m.index" :index="m.index">{{ m.label }}</el-menu-item>
        </el-menu>
        <div class="hint" style="padding: 10px 14px; border-top: 1px solid var(--el-border-color)">
          :{{ port }} · {{ env.repoVersion ? 'repo ' + env.repoVersion : '' }}
        </div>
      </el-aside>

      <el-container>
        <el-header class="hd" height="auto">
          <h1>{{ route.meta.title }}</h1>
          <span class="sp"></span>
          <el-tag
            v-for="(c, k) in env.checks"
            :key="k"
            :type="c.ok ? 'success' : 'danger'"
            size="small"
            effect="plain"
            :title="c.path"
          >
            {{ checkNames[k] || k }} {{ c.ok ? '✓' : '✗' }}
          </el-tag>
          <el-button size="small" :loading="refreshing" @click="reload">⟳ 刷新</el-button>
        </el-header>

        <el-main class="main">
          <router-view />
        </el-main>
      </el-container>
    </el-container>
  </el-config-provider>
</template>
