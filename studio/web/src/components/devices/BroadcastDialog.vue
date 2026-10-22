<script setup>
import { reactive, ref } from 'vue';
import { broadcast } from '@/api/voice';
import { useApi } from '@/composables/useApi';

const visible = ref(false);
const { loading: sending, run } = useApi();
const form = reactive({ deviceIds: [], text: '' });

async function send() {
  const text = form.text.trim();
  if (!text) {
    ElMessage.warning('请输入要播报的文字');
    return;
  }
  const ids = form.deviceIds || [];
  const r = await run(async () => {
    if (ids.length === 0) return broadcast({ text });
    let n = 0;
    let err = '';
    for (const id of ids) {
      const one = await broadcast({ deviceId: id, text });
      if (one.success) n += one.devices || 0;
      else err = one.error || err;
    }
    return { success: n > 0, devices: n, error: err, scoped: true };
  });
  if (!r) return;
  if (r.success) {
    const scope = r.scoped && ids.length > r.devices ? '（其余不在线）' : '';
    ElMessage.success(`已受理，正在播报到 ${r.devices} 台设备${scope}`);
    visible.value = false;
  } else {
    ElMessage.error(r.error || (ids.length ? '所选设备均不在线，未能播报' : '发送失败'));
  }
}

function open(deviceIds = []) {
  form.deviceIds = deviceIds;
  form.text = '';
  visible.value = true;
}

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="visible" title="语音广播（TTS 播报）" width="460px">
    <div class="row">
      <span class="mono">目标: {{ form.deviceIds.length ? form.deviceIds.join('、') : '全部在线设备' }}</span>
    </div>
    <el-input
      v-model="form.text"
      type="textarea"
      :rows="3"
      placeholder="输入要播报的文字…"
      maxlength="500"
      show-word-limit
    />
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="sending" @click="send">发送</el-button>
    </template>
  </el-dialog>
</template>
