<script setup>
import { reactive, ref } from 'vue';
import { getPracticeSettings, setPracticeSettings } from '@/api/settings';
import { useApi } from '@/composables/useApi';

const visible = ref(false);
const { loading: saving, run } = useApi();
const form = reactive({ enabled: false, endMode: 'manual', silenceTimeoutMs: 120000, summaryPrompt: '' });

async function open() {
  const r = await run(() => getPracticeSettings());
  if (r && r.ok && r.practice) Object.assign(form, r.practice);
  visible.value = true;
}

async function save() {
  const r = await run(() => setPracticeSettings({ ...form }));
  if (!r) return;
  if (r.ok) {
    ElMessage.success(`已保存（在线会话已应用 ${r.applied} 台）` + (r.persisted ? '' : '（未能写入配置文件）'));
    visible.value = false;
  } else {
    ElMessage.error(r.error || '保存失败');
  }
}

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="visible" title="口语练习模式" width="520px">
    <el-form label-width="150px">
      <el-form-item label="全局开启">
        <el-switch v-model="form.enabled" />
        <span class="hint" style="margin-left: 10px">保存时同时作用于所有在线会话</span>
      </el-form-item>
      <el-form-item label="默认收卷方式">
        <el-radio-group v-model="form.endMode">
          <el-radio value="manual">手动结束（按设备按钮，零额外token）</el-radio>
          <el-radio value="auto">自动结束（LLM判断说完）</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="讲述静默超时(ms)">
        <el-input-number v-model="form.silenceTimeoutMs" :min="10000" :max="600000" :step="10000" />
      </el-form-item>
      <el-form-item label="总结点评提示词">
        <el-input v-model="form.summaryPrompt" type="textarea" :rows="4" placeholder="留空=用内置口语教练提示词" />
      </el-form-item>
    </el-form>
    <div class="hint" style="line-height: 1.7">
      长段讲述不抢答：进入模式后停顿切出的片段只静默聚合，不再逐句应答。<br />语音进出：“进入口语模式”/“退出口语模式”；模式内可说“手动结束”/“自动结束”切换收卷方式（触发词在聊天页“模式触发词”标签页自由定义，支持多语言）。<br />手动结束=讲完按设备按钮收卷；自动结束=每段多一次小
      LLM 调用判断是否说完。<br />静默超时未收卷会自动总结，防状态悬挂。
    </div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存设定</el-button>
    </template>
  </el-dialog>
</template>
