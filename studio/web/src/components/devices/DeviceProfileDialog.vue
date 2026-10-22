<script setup>
import { computed, reactive, ref } from 'vue';
import { getDeviceSettings, setDeviceSettings } from '@/api/settings';
import { useApi } from '@/composables/useApi';
import { useRobotActions } from '@/composables/useRobotActions';
import { useRobotStatus } from '@/composables/useRobotStatus';

const visible = ref(false);
// 分区折叠面板：默认展开"语音与音频/人设"，机器人/家居收起（内容较多）
const activeSections = ref(['audio', 'persona']);
const { loading: saving, run } = useApi();
const { state: robotStatus, bodyOptions, load: loadRobotStatus } = useRobotStatus();
const { allActionIds, actionGroups, ensureLoaded } = useRobotActions();

const form = reactive({
  deviceId: '',
  language: '',
  minMaxAmplitude: null,
  minAvgAmplitude: null,
  silenceThresholdMs: null,
  speechToNoiseMin: null,
  minActiveWindows: null,
  personaName: '',
  personaPersonality: '',
  robotEnabled: false,
  robotMaxFunctions: null,
  robotBody: '',
  robotActions: [],
  homeEnabled: false,
});

const robotEffective = computed(() => {
  const cap = form.robotMaxFunctions;
  const total = robotStatus.totalTools || 0;
  return Number.isFinite(Number(cap)) && cap !== null && cap !== '' ? Math.min(Number(cap), total) : total;
});

function reset(deviceId) {
  Object.assign(form, {
    deviceId,
    language: '',
    minMaxAmplitude: null,
    minAvgAmplitude: null,
    silenceThresholdMs: null,
    speechToNoiseMin: null,
    minActiveWindows: null,
    personaName: '',
    personaPersonality: '',
    robotEnabled: false,
    robotMaxFunctions: null,
    robotBody: '',
    robotActions: [],
    homeEnabled: false,
  });
}

async function open(deviceId) {
  if (!deviceId) {
    ElMessage.warning('该行没有设备ID');
    return;
  }
  reset(deviceId);
  activeSections.value = ['audio', 'persona'];
  visible.value = true;
  loadRobotStatus();
  await ensureLoaded();
  const r = await run(() => getDeviceSettings(deviceId));
  if (!r) return;
  if (r.ok) {
    const s = r.settings || {};
    const a = s.audio || {};
    const rb = s.robot || {};
    form.language = s.language || '';
    form.minMaxAmplitude = a.minMaxAmplitude ?? null;
    form.minAvgAmplitude = a.minAvgAmplitude ?? null;
    form.silenceThresholdMs = a.silenceThresholdMs ?? null;
    form.speechToNoiseMin = a.speechToNoiseMin ?? null;
    form.minActiveWindows = a.minActiveWindows ?? null;
    const p = s.persona || {};
    form.personaName = p.name || '';
    form.personaPersonality = p.personality || '';
    form.robotEnabled = rb.enabled === true;
    form.robotMaxFunctions = rb.maxFunctions === undefined || rb.maxFunctions === null ? null : rb.maxFunctions;
    form.robotBody = rb.body || '';
    // rb.actions 未配置(旧设备) → 默认全选（等价“全部注入”）；已配置 → 按保存值预勾
    form.robotActions = Array.isArray(rb.actions)
      ? rb.actions.filter((x) => allActionIds.value.includes(x))
      : allActionIds.value.slice();
    form.homeEnabled = !!(s.home && s.home.enabled === true);
  }
}

async function save() {
  const r = await run(() =>
    setDeviceSettings({
      deviceId: form.deviceId,
      language: form.language || null,
      audio: {
        minMaxAmplitude: form.minMaxAmplitude,
        minAvgAmplitude: form.minAvgAmplitude,
        silenceThresholdMs: form.silenceThresholdMs,
        speechToNoiseMin: form.speechToNoiseMin,
        minActiveWindows: form.minActiveWindows,
      },
      persona: {
        name: form.personaName || null,
        personality: form.personaPersonality || null,
      },
      robot: {
        enabled: form.robotEnabled,
        maxFunctions: form.robotMaxFunctions,
        body: form.robotBody || null,
        actions: form.robotEnabled ? form.robotActions : null,
      },
      home: { enabled: form.homeEnabled },
    }),
  );
  if (!r) return;
  if (r.ok) {
    ElMessage.success(`设备 ${form.deviceId} 个体设定已保存并即时生效`);
    visible.value = false;
  } else {
    ElMessage.error(r.error || '保存失败');
  }
}

function selectAllActions() {
  form.robotActions = allActionIds.value.slice();
}

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="visible" title="设备语音与语言（个体设定）" width="480px">
    <div class="row"><span class="mono">设备: {{ form.deviceId }}</span></div>
    <el-form label-width="130px">
      <el-collapse v-model="activeSections" class="profile-collapse">
        <el-collapse-item title="语音与音频" name="audio">
      <el-form-item label="默认语言">
        <el-select v-model="form.language" style="width: 180px">
          <el-option value="" label="跟随全局" />
          <el-option value="zh" label="中文" />
          <el-option value="ja" label="日本語" />
          <el-option value="en" label="English" />
        </el-select>
      </el-form-item>
      <el-form-item label="最大振幅阈值">
        <el-input-number
          v-model="form.minMaxAmplitude"
          :min="0"
          :max="10000"
          :step="50"
          :value-on-clear="null"
          controls-position="right"
          style="width: 150px"
        />
        <span class="hint" style="margin-left: 8px">空=跟随全局</span>
      </el-form-item>
      <el-form-item label="平均振幅阈值">
        <el-input-number
          v-model="form.minAvgAmplitude"
          :min="0"
          :max="10000"
          :step="5"
          :value-on-clear="null"
          controls-position="right"
          style="width: 150px"
        />
        <span class="hint" style="margin-left: 8px">空=跟随全局</span>
      </el-form-item>
      <el-form-item label="静默阈值(ms)">
        <el-input-number
          v-model="form.silenceThresholdMs"
          :min="300"
          :max="5000"
          :step="100"
          :value-on-clear="null"
          controls-position="right"
          style="width: 150px"
        />
        <span class="hint" style="margin-left: 8px">空=跟随全局</span>
      </el-form-item>
      <el-form-item label="语音对比度下限">
        <el-input-number
          v-model="form.speechToNoiseMin"
          :min="1"
          :max="10"
          :step="0.1"
          :value-on-clear="null"
          controls-position="right"
          style="width: 150px"
        />
        <span class="hint" style="margin-left: 8px">空=全局(3.0)·调小更易识别小声</span>
      </el-form-item>
      <el-form-item label="最少持续窗数">
        <el-input-number
          v-model="form.minActiveWindows"
          :min="1"
          :max="10"
          :step="1"
          :value-on-clear="null"
          controls-position="right"
          style="width: 150px"
        />
        <span class="hint" style="margin-left: 8px">空=全局(2)·调小更易识别短句</span>
      </el-form-item>

        </el-collapse-item>
        <el-collapse-item title="人设（注入大模型）" name="persona">
      <el-form-item label="名字">
        <el-input v-model="form.personaName" maxlength="30" placeholder="空=默认「小智」" style="width: 180px" />
        <span class="hint" style="margin-left: 8px">它自报家门时的称呼（如“大酒桶”）</span>
      </el-form-item>
      <el-form-item label="性格">
        <el-input
          v-model="form.personaPersonality"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="如：活泼调皮，喜欢开玩笑，回答简短幽默"
          style="width: 100%"
        />
        <span class="hint">留空=不附加性格描述；保存后下一轮对话即生效</span>
      </el-form-item>

        </el-collapse-item>
        <el-collapse-item title="机器人（function calling）" name="robot">
      <el-form-item label="是否为机器人">
        <el-switch v-model="form.robotEnabled" />
        <span class="hint" style="margin-left: 8px">
          开启后：对该设备会话注入机器人身体人设，并将在线设备工具作为 function 交给大模型调用
        </span>
      </el-form-item>
      <el-form-item label="function 数量上限">
        <el-input-number
          v-model="form.robotMaxFunctions"
          :min="0"
          :max="64"
          :step="1"
          :value-on-clear="null"
          controls-position="right"
          style="width: 150px"
          :disabled="!form.robotEnabled"
        />
        <span class="hint" style="margin-left: 8px">空=全部工具 · 当前生效 {{ robotEffective }} 个</span>
      </el-form-item>
      <el-form-item label="控制硬件">
        <el-select
          v-model="form.robotBody"
          placeholder="未绑定（回退全局）"
          clearable
          :disabled="!form.robotEnabled"
          style="width: 320px"
        >
          <el-option v-for="o in bodyOptions" :key="o.value" :label="o.label" :value="o.value" />
        </el-select>
        <span class="hint" style="margin-left: 8px">绑定这台小智专属指挥的身体，一一对应、避免指挥错乱（离线身体不下发）</span>
      </el-form-item>
      <el-form-item v-if="form.robotEnabled" label="装载动作类型">
        <div style="width: 100%">
          <div class="row" style="margin-bottom: 6px">
            <el-button size="small" text @click="selectAllActions">全选</el-button>
            <el-button size="small" text @click="form.robotActions = []">清空</el-button>
            <span class="hint">仅将勾选的动作注入大模型；未选的动作不会出现在可调用工具里</span>
          </div>
          <div v-for="g in actionGroups" :key="g.label" style="margin-bottom: 6px">
            <div class="hint" style="margin: 2px 0">{{ g.label }}</div>
            <el-checkbox-group v-model="form.robotActions">
              <el-checkbox v-for="a in g.items" :key="a.id" :value="a.id" style="margin: 0 14px 0 0">
                <span :title="a.note">{{ a.label }}</span>
                <el-tag v-if="!a.wired" size="small" type="info" effect="plain" style="margin-left: 4px">未接线</el-tag>
                <el-tag v-else-if="a.id === 'robot_drive'" size="small" type="warning" effect="plain" style="margin-left: 4px">
                  需放开红线
                </el-tag>
              </el-checkbox>
            </el-checkbox-group>
          </div>
          <div v-if="!actionGroups.length" class="hint">动作目录加载中…</div>
        </div>
      </el-form-item>

        </el-collapse-item>
        <el-collapse-item title="家居（HomeKit）" name="home">
      <el-form-item label="允许控制家居设备">
        <el-switch v-model="form.homeEnabled" />
        <span class="hint" style="margin-left: 8px">
          开启后：这台小智的会话挂载已配对的 HomeKit 灯具工具（如“打开台灯”）；未开启的设备无法语音控家居
        </span>
      </el-form-item>
        </el-collapse-item>
      </el-collapse>
    </el-form>
    <div class="hint" style="line-height: 1.7">
      个体设定仅作用于该设备：默认语言决定屏幕状态文案/模式标签/欢迎语及播报确认语的语种，并作为语音播报音色托底；能识别出其它语种的回复仍自动选对应音色。留空/选「跟随全局」则使用全局默认。保存即时生效（在线设备秒级热推，持久化到设备库，重启不丢）。
    </div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.profile-collapse {
  border-top: none;
}
.profile-collapse :deep(.el-collapse-item__header) {
  font-weight: 600;
}
.profile-collapse :deep(.el-collapse-item__content) {
  padding: 6px 4px 14px;
  padding-bottom: 12px;
}
</style>
