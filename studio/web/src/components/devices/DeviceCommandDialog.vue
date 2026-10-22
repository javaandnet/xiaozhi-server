<script setup>
import { reactive, ref } from 'vue';
import { callDeviceTool, listDeviceTools } from '@/api/mcp';
import { sendDeviceCommand } from '@/api/voice';

const visible = ref(false);
const form = reactive({
  device: '',
  label: '',
  kind: 'voice',
  tab: 'say',
  text: '',
  tools: [],
  tool: '',
  argsText: '{}',
  loading: false,
  sending: false,
  result: '',
  speak: true,
});

/** Build an example argument object from a tool's JSON schema. */
function sampleArgs(params) {
  const props = (params && params.properties) || {};
  const out = {};
  for (const k of Object.keys(props)) {
    const p = props[k] || {};
    if (Array.isArray(p.enum) && p.enum.length) out[k] = p.enum[0];
    else if (p.type === 'integer' || p.type === 'number') out[k] = 0;
    else if (p.type === 'boolean') out[k] = false;
    else if (p.type === 'array') out[k] = [];
    else if (p.type === 'object') out[k] = {};
    else out[k] = '';
  }
  return out;
}

function selectTool(name) {
  form.tool = name;
  const t = form.tools.find((x) => x.name === name);
  form.argsText = JSON.stringify(sampleArgs(t && t.parameters), null, 2);
}

async function loadTools() {
  form.loading = true;
  try {
    const r = await listDeviceTools(form.device);
    form.tools = r && r.ok && r.tools ? r.tools : [];
  } catch (e) {
    form.tools = [];
    ElMessage.error('工具列表加载失败: ' + e.message);
  } finally {
    form.loading = false;
  }
  if (form.tools.length && !form.tools.some((t) => t.name === form.tool)) selectTool(form.tools[0].name);
}

function open({ device, label, kind = 'voice' }) {
  if (!device) {
    ElMessage.warning('该行缺少设备标识');
    return;
  }
  Object.assign(form, {
    device: String(device),
    label: label || device,
    kind: kind === 'body' ? 'body' : 'voice',
    tab: 'say',
    text: '',
    tools: [],
    tool: '',
    argsText: '{}',
    result: '',
    speak: true,
  });
  visible.value = true;
  loadTools();
}

async function runTextCommand() {
  if (!form.text.trim()) {
    ElMessage.warning('请输入指令内容');
    return;
  }
  form.sending = true;
  form.result = '';
  try {
    const r = await sendDeviceCommand({
      device: form.device,
      text: form.text.trim(),
      speak: form.speak,
      kind: form.kind,
    });
    if (r.ok) {
      if (r.routed === 'device') {
        form.result =
          '✓ 已模拟该小智设备发送识别文字，回复将由设备自己执行并语音播报（等同当面说话；结果见设备屏幕/服务端日志）';
        ElMessage.success('已走设备正链路');
      } else {
        let out = '✓ ' + (r.reply || '(已执行，无文本回复)');
        if (form.speak) {
          out += r.spoken
            ? '\n🔊 已经小智设备播报: ' + r.spoken
            : '\n⚠ 未找到该身体绑定的在线小智语音设备（未播报）';
        }
        form.result = out;
        ElMessage.success('已执行');
      }
    } else {
      form.result = '✕ ' + (r.error || '执行失败');
      ElMessage.error(r.error || '执行失败');
    }
  } catch (e) {
    form.result = '✕ ' + e.message;
    ElMessage.error(e.message);
  } finally {
    form.sending = false;
  }
}

async function runToolCall() {
  let args;
  try {
    args = form.argsText.trim() ? JSON.parse(form.argsText) : {};
  } catch (e) {
    form.result = '';
    ElMessage.error('参数不是合法 JSON: ' + e.message);
    return;
  }
  form.sending = true;
  form.result = '';
  try {
    const r = await callDeviceTool({ device: form.device, tool: form.tool, args });
    form.result = r.ok ? '✓ ' + (r.result == null ? '(无返回)' : r.result) : '✕ ' + (r.error || '调用失败');
    if (r.ok) ElMessage.success('指令已下发');
    else ElMessage.error(r.error || '调用失败');
  } catch (e) {
    form.result = '✕ ' + e.message;
    ElMessage.error(e.message);
  } finally {
    form.sending = false;
  }
}

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="visible" :title="'对硬件下指令 · ' + form.label" width="560px">
    <div class="hint mono" style="margin-bottom: 8px">目标 device: {{ form.device }}</div>
    <el-tabs v-model="form.tab">
      <el-tab-pane label="自然语言指令" name="say">
        <el-input
          v-model="form.text"
          type="textarea"
          :rows="3"
          :placeholder="
            form.kind === 'body'
              ? '像说话一样给身体下指令，如：挥挥手 / 跳个舞 / 播放音乐'
              : '模拟对小智说话，如：打开台灯 / 今天天气'
          "
        />
        <div v-if="form.kind === 'body'" class="hint" style="margin: 6px 0">
          指令文本交给该身体的 LLM 分析→调用其工具→执行动作，回复经其绑定的小智语音设备播报（结果在下方回显）
        </div>
        <div v-else class="hint" style="margin: 6px 0">
          模拟该小智设备向 server 发送识别文字（等同当面说话）：走唯一正链路，工具装配/白名单/执行/播报全部与语音一致；回复由设备自己播报（需设备在线；家居控制需先在⚙设定开启“允许控制家居设备”）
        </div>
        <el-checkbox v-if="form.kind === 'body'" v-model="form.speak" style="margin-bottom: 6px">
          🔊 将回复经该身体绑定的小智语音设备播报（TTS）
        </el-checkbox>
        <pre v-show="form.result" class="result mono">{{ form.result }}</pre>
        <el-button
          type="primary"
          :loading="form.sending"
          :disabled="!form.text.trim()"
          style="margin-top: 4px"
          @click="runTextCommand"
        >
          发送指令
        </el-button>
      </el-tab-pane>
      <el-tab-pane label="直调工具（高级）" name="tool">
        <el-form label-width="60px">
          <el-form-item label="工具">
            <el-select v-model="form.tool" :loading="form.loading" placeholder="选择工具" style="width: 100%" @change="selectTool">
              <el-option v-for="t in form.tools" :key="t.name" :label="t.name" :value="t.name">
                <span class="mono">{{ t.name }}</span>
                <span class="hint" style="float: right">{{ (t.description || '').slice(0, 40) }}</span>
              </el-option>
            </el-select>
            <span v-if="!form.loading && !form.tools.length" class="hint">该硬件当前离线或不提供 MCP 工具</span>
          </el-form-item>
          <el-form-item label="参数">
            <el-input v-model="form.argsText" type="textarea" :rows="4" class="mono" placeholder="{}" />
          </el-form-item>
        </el-form>
        <pre v-show="form.result" class="result mono">{{ form.result }}</pre>
        <el-button :disabled="form.loading" style="margin-top: 4px" @click="loadTools">⟳ 刷新工具</el-button>
        <el-button type="primary" :loading="form.sending" :disabled="!form.tool" style="margin-top: 4px" @click="runToolCall">
          发送指令
        </el-button>
      </el-tab-pane>
    </el-tabs>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>
