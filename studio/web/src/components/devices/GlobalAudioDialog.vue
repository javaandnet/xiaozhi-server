<script setup>
import { reactive, ref } from 'vue';
import {
  getAudioThresholds,
  getDefaultLanguage,
  setAudioThresholds,
  setDefaultLanguage,
} from '@/api/settings';
import { useApi } from '@/composables/useApi';

const visible = ref(false);
const { loading: saving, run } = useApi();
const form = reactive({ minMaxAmplitude: 500, minAvgAmplitude: 50, silenceThresholdMs: 1500, language: 'zh' });

async function open() {
  try {
    const [r, lg] = await Promise.all([getAudioThresholds(), getDefaultLanguage()]);
    if (r.ok && r.thresholds) Object.assign(form, r.thresholds);
    if (lg && lg.ok) form.language = lg.default;
  } catch (e) {
    ElMessage.error('读取设置失败: ' + e.message);
  }
  visible.value = true;
}

async function save() {
  const { language, ...thresholds } = form;
  const r = await run(() => Promise.all([setAudioThresholds(thresholds), setDefaultLanguage({ default: language })]));
  if (!r) return;
  const [audio, lang] = r;
  if (audio.ok && lang && lang.ok) {
    ElMessage.success(
      `已保存并即时生效: max=${audio.thresholds.minMaxAmplitude}, avg=${audio.thresholds.minAvgAmplitude}, 静默=${audio.thresholds.silenceThresholdMs}ms，默认语言=${lang.default}` +
        (audio.persisted ? '' : '（未能写入配置文件）'),
    );
    visible.value = false;
  } else {
    ElMessage.error(audio?.error || lang?.error || '保存失败');
  }
}

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="visible" title="语音与语言设置" width="480px">
    <el-form label-width="130px">
      <el-form-item label="默认语言（托底）">
        <el-select v-model="form.language" style="width: 180px">
          <el-option value="zh" label="中文" />
          <el-option value="ja" label="日本語" />
          <el-option value="en" label="English" />
        </el-select>
      </el-form-item>
      <el-form-item label="最大振幅阈值">
        <el-input-number v-model="form.minMaxAmplitude" :min="0" :max="10000" :step="50" />
      </el-form-item>
      <el-form-item label="平均振幅阈值">
        <el-input-number v-model="form.minAvgAmplitude" :min="0" :max="10000" :step="5" />
      </el-form-item>
      <el-form-item label="静默阈值(ms)">
        <el-input-number v-model="form.silenceThresholdMs" :min="300" :max="5000" :step="100" />
      </el-form-item>
    </el-form>
    <div class="hint" style="line-height: 1.7">
      默认语言：对话时自动跟随用户语种（中/日/英由云端识别与音色选择接管）；无法判断语种时（及唤醒欢迎语）按此托底。保存即时生效。<br />振幅低于任一阈值的音频视为噪音，不触发识别、不发起对话轮次。<br />静默阈值：realtime
      常开麦下，说话停顿超过该时长才判定“一句话说完”并触发识别；值太小会把长句切碎成短句碎片（建议 1200~1500ms）。<br />环境嘈杂时调大振幅数值；保存后立即生效（服务器默认值，重启不丢）。
    </div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存设定</el-button>
    </template>
  </el-dialog>
</template>
