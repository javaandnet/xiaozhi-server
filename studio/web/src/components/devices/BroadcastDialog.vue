<script setup>
import { reactive, ref } from 'vue';
import { broadcast } from '@/api/voice';
import { useApi } from '@/composables/useApi';

const visible = ref(false);
const { loading: sending, run } = useApi();
const form = reactive({ deviceIds: [], text: '' });

// blur 时浏览器才派发 change，el-input 的 handleChange 会用 model 值回写 DOM；
// 中文输入法未上屏（isComposing）期间 model 拿不到文字，回写会把刚输入的内容抹掉。
// 故 blur 先以 DOM 实际值兜底同步一次 model。
function syncText(event) {
  const v = event?.target?.value;
  if (typeof v === 'string' && v !== form.text) form.text = v;
}

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
    form.text = '';
    visible.value = false;
  } else {
    ElMessage.error(r.error || (ids.length ? '所选设备均不在线，未能播报' : '发送失败'));
  }
}

function open(deviceIds = []) {
  // 只切换目标设备，保留上次草稿：误触外部关闭后重开不再丢字
  form.deviceIds = deviceIds;
  visible.value = true;
}

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="visible" title="语音广播（TTS 播报）" width="460px" :close-on-click-modal="false">
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
      @blur="syncText"
    />
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="sending" @click="send">发送</el-button>
    </template>
  </el-dialog>
</template>
