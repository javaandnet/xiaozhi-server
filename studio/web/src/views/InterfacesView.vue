<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { getInterfaces, saveInterfaces } from '@/api/interfaces';
import { useRefreshBus } from '@/composables/useRefreshBus';

const { register, unregister } = useRefreshBus();

const loading = ref(false);
const saving = ref(false);
const dirty = ref(false);
const revealToken = ref(false);

// 能力枚举（由后端下发，UI 不硬编码封闭集）
const caps = reactive({ inbound: [], outbound: [] });

// 共享密钥 + voiceFlow SSRF 白名单
const sharedToken = ref('');
const voiceFlowTokenRef = ref(''); // 只读展示（固定 "$shared"）
const allowList = ref([]); // string[]

// 外部系统（扁平编辑模型，保存时重组为嵌套注册表）
const systems = ref([]); // [{name, enabled, baseUrl, token, inbound[], outEmp, empPath, empTimeoutMs, outFlow, flowHost, flowPort, flowPath}]

function blankSystem() {
  return {
    name: '',
    enabled: true,
    baseUrl: '',
    token: '$shared',
    inbound: ['voiceFlow'],
    outEmp: false,
    empPath: '/api/xiaozhi/employee-turn',
    empTimeoutMs: 90000,
    outFlow: false,
    flowHost: '',
    flowPort: 3007,
    flowPath: '/api/xiaozhi/flow-callback',
  };
}

function fromRegistry(name, s = {}) {
  const emp = (s.outbound && s.outbound.employeeTurn) || null;
  const flow = (s.outbound && s.outbound.flowCallback) || null;
  return {
    name,
    enabled: s.enabled !== false,
    baseUrl: s.baseUrl || '',
    token: s.token || '$shared',
    inbound: Array.isArray(s.inbound) ? [...s.inbound] : [],
    outEmp: !!emp,
    empPath: (emp && emp.path) || '/api/xiaozhi/employee-turn',
    empTimeoutMs: (emp && emp.timeoutMs) || 90000,
    outFlow: !!flow,
    flowHost: (flow && flow.host) || '',
    flowPort: (flow && flow.port) || 3007,
    flowPath: (flow && flow.path) || '/api/xiaozhi/flow-callback',
  };
}

async function load() {
  loading.value = true;
  try {
    const data = await getInterfaces();
    caps.inbound = data.capabilities?.inbound || [];
    caps.outbound = data.capabilities?.outbound || [];
    sharedToken.value = data.sharedToken || '';
    voiceFlowTokenRef.value = data.voiceFlowTokenRef || '';
    allowList.value = [...(data.voiceFlowCallbackAllowList || [])];
    systems.value = Object.entries(data.externalSystems || {}).map(([name, s]) => fromRegistry(name, s));
    dirty.value = false;
  } catch (e) {
    ElMessage.error('读取接口配置失败：' + e.message);
  } finally {
    loading.value = false;
  }
}

function addSystem() {
  systems.value.push(blankSystem());
  dirty.value = true;
}

async function removeSystem(idx) {
  const s = systems.value[idx];
  await ElMessageBox.confirm(`确认删除外部系统「${s.name || '(未命名)'}」？保存后生效。`, '删除', { type: 'warning' });
  systems.value.splice(idx, 1);
  dirty.value = true;
}

function markDirty() {
  dirty.value = true;
}

function genToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  sharedToken.value = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  markDirty();
  ElMessage.success('已生成新的 64 位十六进制共享密钥（记得同步给各外部系统）');
}

const hasAllow = computed(() => allowList.value.length > 0);

function buildPayload() {
  const externalSystems = {};
  const seen = new Set();
  for (const s of systems.value) {
    const name = String(s.name || '').trim();
    if (!name) throw new Error('存在未命名的外部系统');
    if (seen.has(name)) throw new Error(`系统名重复：${name}`);
    seen.add(name);
    const outbound = {};
    if (s.outEmp) outbound.employeeTurn = { path: s.empPath, timeoutMs: Number(s.empTimeoutMs) || 90000 };
    if (s.outFlow) {
      const fc = { path: s.flowPath };
      if (String(s.flowHost || '').trim()) fc.host = String(s.flowHost).trim();
      if (Number(s.flowPort)) fc.port = Number(s.flowPort);
      outbound.flowCallback = fc;
    }
    const entry = {
      enabled: !!s.enabled,
      token: String(s.token || '').trim() || '$shared',
      inbound: [...s.inbound],
    };
    if (String(s.baseUrl || '').trim()) entry.baseUrl = String(s.baseUrl).trim();
    if (Object.keys(outbound).length) entry.outbound = outbound;
    externalSystems[name] = entry;
  }
  return {
    sharedToken: sharedToken.value,
    voiceFlowCallbackAllowList: allowList.value.map((x) => String(x).trim()).filter(Boolean),
    externalSystems,
  };
}

async function save() {
  let payload;
  try {
    payload = buildPayload();
  } catch (e) {
    ElMessage.error(e.message);
    return;
  }
  saving.value = true;
  try {
    const r = await saveInterfaces(payload);
    if (r.ok) {
      ElMessage.success(r.reloaded ? '已保存并热重载生效' : '已保存（请重启服务生效）');
      dirty.value = false;
      await load();
    } else {
      ElMessage.error('保存失败：' + (r.error || '未知错误'));
    }
  } catch (e) {
    ElMessage.error('保存失败：' + e.message);
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  register(load);
  load();
});
onBeforeUnmount(unregister);

function beforeUnload(e) {
  if (dirty.value) {
    e.preventDefault();
    e.returnValue = '';
  }
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', beforeUnload);
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header>
      <div style="display: flex; align-items: center; gap: 10px">
        <b>🔌 外界系统接口</b>
        <span class="hint">xiaozhi-server 与外部控制器（aistudy / aiinterview / …）的集成配置，保存后即时热重载</span>
        <el-button size="small" text :loading="loading" style="margin-left: auto" @click="load">⟳ 重新读取</el-button>
        <el-button size="small" type="primary" :loading="saving" :disabled="!dirty" @click="save">
          💾 保存<span v-if="dirty" style="color: var(--el-color-danger)"> ●</span>
        </el-button>
      </div>
    </template>

    <el-form label-width="130px" style="max-width: 760px" @submit.prevent>
      <el-form-item label="共享密钥 sharedToken">
        <div style="display: flex; gap: 8px; width: 100%">
          <el-input
            v-model="sharedToken"
            :type="revealToken ? 'text' : 'password'"
            placeholder="顶层唯一密钥源；各系统 token 写 $shared 即引用它"
            @input="markDirty"
          />
          <el-button size="small" @click="revealToken = !revealToken">{{ revealToken ? '隐藏' : '显示' }}</el-button>
          <el-button size="small" @click="genToken">🎲 随机生成</el-button>
        </div>
        <div class="hint" style="width: 100%">
          这是敏感密钥。留空则所有 <span class="mono">$shared</span> 引用解析为空，voiceFlow 将返回 503（禁用）。
        </div>
      </el-form-item>
      <el-form-item label="voiceFlow.token">
        <el-input :model-value="voiceFlowTokenRef" disabled style="max-width: 240px" />
        <span class="hint" style="margin-left: 8px">固定 <span class="mono">$shared</span>，由 sharedToken 单源解析，不在此处编辑</span>
      </el-form-item>
      <el-form-item label="回调白名单 (SSRF)">
        <el-select
          v-model="allowList"
          multiple
          filterable
          allow-create
          default-first-option
          :reserve-keyword="false"
          placeholder="输入 host / origin / .suffix 后回车添加，如 127.0.0.1、ai.fsr.co.jp"
          style="width: 100%"
          @change="markDirty"
        />
        <div v-if="!hasAllow" class="hint" style="width: 100%; color: var(--el-color-warning)">
          白名单为空将拒绝所有 flowCallback 回调地址（安全默认）。
        </div>
      </el-form-item>
    </el-form>
  </el-card>

  <el-card class="card" shadow="never">
    <template #header>
      <div style="display: flex; align-items: center; gap: 10px">
        <b> 外部系统注册表 externalSystems</b>
        <span class="hint">每系统声明：入站能力（谁能调我们）+ 出站能力（我们调谁）</span>
        <el-button size="small" style="margin-left: auto" @click="addSystem">➕ 添加系统</el-button>
      </div>
    </template>

    <div v-if="!systems.length" class="hint">暂无外部系统 — 点“添加系统”登记第一个。</div>

    <div>
      <div v-for="(s, idx) in systems" :key="idx" class="sys-block">
        <el-card shadow="never" class="sys-inner">
          <div class="row" style="align-items: center; margin-bottom: 10px">
            <el-input v-model="s.name" size="small" placeholder="系统名（如 aistudy）" style="width: 200px" @input="markDirty" />
            <span class="hint">启用</span>
            <el-switch v-model="s.enabled" size="small" @change="markDirty" />
            <el-button size="small" type="danger" plain style="margin-left: auto" @click="removeSystem(idx)">删除</el-button>
          </div>

          <el-form label-width="110px" size="small" @submit.prevent>
            <el-form-item label="baseUrl">
              <el-input v-model="s.baseUrl" placeholder="出站 employeeTurn 的目标基址（无出站可留空）" @input="markDirty" />
            </el-form-item>
            <el-form-item label="token">
              <el-input v-model="s.token" placeholder="$shared 或明文密钥" style="max-width: 420px" @input="markDirty" />
            </el-form-item>
            <el-form-item label="入站能力">
              <el-checkbox-group v-model="s.inbound" @change="markDirty">
                <el-checkbox v-for="c in caps.inbound" :key="c" :value="c" :label="c" />
              </el-checkbox-group>
            </el-form-item>
            <el-form-item label="出站能力">
              <div style="width: 100%">
                <el-checkbox v-model="s.outEmp" @change="markDirty">employeeTurn（数字员工轮次）</el-checkbox>
                <div v-if="s.outEmp" class="row sub-fields">
                  <span class="hint">path</span>
                  <el-input v-model="s.empPath" style="width: 280px" @input="markDirty" />
                  <span class="hint">timeoutMs</span>
                  <el-input-number v-model="s.empTimeoutMs" :min="1000" :step="1000" controls-position="right" style="width: 140px" @change="markDirty" />
                </div>
                <el-checkbox v-model="s.outFlow" @change="markDirty">flowCallback（收卷回调 host 登记）</el-checkbox>
                <div v-if="s.outFlow" class="row sub-fields">
                  <span class="hint">host</span>
                  <el-input v-model="s.flowHost" placeholder="127.0.0.1" style="width: 160px" @input="markDirty" />
                  <span class="hint">port</span>
                  <el-input-number v-model="s.flowPort" :min="1" :max="65535" controls-position="right" style="width: 130px" @change="markDirty" />
                  <span class="hint">path</span>
                  <el-input v-model="s.flowPath" style="width: 240px" @input="markDirty" />
                </div>
                <div class="hint" style="margin-top: 4px">
                  flowCallback 仅登记 host 进 SSRF 白名单；回调 URL 本身仍由控制器按会话下发（控制器权威）。
                </div>
              </div>
            </el-form-item>
          </el-form>
        </el-card>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.sys-block {
  margin-bottom: 12px;
}
.sys-inner {
  border: 1px solid var(--el-border-color);
}
.sub-fields {
  margin: 4px 0 8px 24px;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
