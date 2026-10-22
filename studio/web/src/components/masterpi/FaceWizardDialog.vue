<script setup>
import { reactive, ref } from 'vue';
import { useFaces } from '@/composables/useFaces';
import { useFaceStream } from '@/composables/useFaceStream';

const { mpBodyReady, capture, alignCamera, defaultName } = useFaces();
const { mpStream, start: startStream } = useFaceStream();

const visible = ref(false);
const wizard = reactive({ mode: 'new', targetId: null, step: 1, name: '', result: '', aligning: false });

function open({ mode = 'new', targetId = null, name = '' } = {}) {
  if (!mpBodyReady.value) {
    ElMessage.error(mode === 'append' ? '身体离线，无法采集' : '身体离线，无法登记');
    return;
  }
  wizard.mode = mode;
  wizard.targetId = targetId;
  wizard.step = 1;
  wizard.result = '';
  wizard.name = name || (mode === 'append' ? '' : defaultName());
  visible.value = true;
  if (!mpStream.running) startStream();
}

async function startCapture() {
  const name = wizard.name.trim();
  if (!name) {
    ElMessage.error('请填写称呼');
    return;
  }
  const isAppend = wizard.mode === 'append';
  wizard.step = 3;
  wizard.result = '';
  let r;
  try {
    r = await capture({ name, targetId: isAppend ? wizard.targetId : null });
  } catch (e) {
    r = { ok: false, message: String(e?.message || e) };
  }
  if (r.ok) {
    wizard.result = `✓ 已${isAppend ? '为 ' : '登记：'}${r.name}` + (isAppend ? `（ID ${r.id}，现样本 ${r.samples}）` : `（ID ${r.id}）`);
    wizard.step = 4;
    ElMessage.success((isAppend ? '追加成功：' : '登记成功：') + r.name);
  } else {
    wizard.result = '✕ ' + r.message;
    wizard.step = 2;
    ElMessage.error(r.message);
  }
}

function again() {
  wizard.result = '';
  if (wizard.mode === 'append') {
    wizard.step = 1;
  } else {
    wizard.step = 2;
    wizard.name = defaultName();
  }
}

async function camAlign(action) {
  wizard.aligning = true;
  try {
    await alignCamera(action);
  } finally {
    wizard.aligning = false;
  }
}

defineExpose({ open });
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="wizard.mode === 'append' ? '📷 追加样本向导' : '📷 人脸登记向导'"
    width="760px"
    :close-on-click-modal="false"
    top="6vh"
  >
    <el-steps :active="wizard.step - 1" align-center finish-status="success" style="margin-bottom: 16px">
      <el-step title="1 对准画面" />
      <el-step :title="wizard.mode === 'append' ? '2 确认对象' : '2 填写称呼'" />
      <el-step title="3 采集人脸" />
      <el-step title="4 完成" />
    </el-steps>

    <div style="text-align: center; margin-bottom: 12px">
      <img
        v-if="mpStream.running"
        :src="mpStream.imgSrc"
        style="max-width: 100%; max-height: 360px; border: 1px solid var(--el-border-color); border-radius: 8px"
        alt="live"
      />
      <div v-else class="hint" style="padding: 48px 12px; border: 1px dashed var(--el-border-color); border-radius: 8px">
        摄像头预览未启动（若一直空白，点下方“启动预览画面”）
      </div>
      <div class="row" style="justify-content: center; margin-top: 8px">
        <el-button v-if="!mpStream.running" size="small" type="primary" :loading="mpStream.loading" @click="startStream">
          ▶ 启动预览画面
        </el-button>
        <el-button v-else size="small" text @click="startStream">⟳ 刷新画面</el-button>
      </div>
    </div>

    <div
      v-if="wizard.step === 1 && mpStream.running"
      class="row"
      style="justify-content: center; margin-bottom: 12px; gap: 6px"
    >
      <span class="hint">云台微调（只动俯仰/水平，不碰轮子）：</span>
      <el-button size="small" :loading="wizard.aligning" @click="camAlign('up')">↑ 仰起</el-button>
      <el-button size="small" :loading="wizard.aligning" @click="camAlign('down')">↓ 低头</el-button>
      <el-button size="small" :loading="wizard.aligning" @click="camAlign('left')">← 左转</el-button>
      <el-button size="small" :loading="wizard.aligning" @click="camAlign('right')">→ 右转</el-button>
      <el-button size="small" text @click="camAlign('center')">◎ 回正</el-button>
    </div>

    <div class="wizard-tip">
      <div v-if="wizard.step === 1">
        <b>第一步 · 对准</b><br />请被登记者坐在摄像头正前方约 <b>0.5～1 米</b>，脸位于画面<b>正中</b>、光线充足、正对镜头、摘下口罩/墨镜、保持不动。若画面偏高/偏低，用上方
        <b>↑ 仰起 / ↓ 低头</b> 把镜头调正（一般稍仰一点更好），确认能看到自己的脸后点“下一步”。
      </div>
      <div v-else-if="wizard.step === 2 && wizard.mode === 'append'">
        <b>第二步 · 确认对象</b><br />正在为已登记成员 <b>{{ wizard.name }}</b> 追加样本：采集到的新脸会自动合并进该成员（近重复去重，每人上限
        <b>5</b> 个）。建议换个角度/表情/光照再采几次。确认点“开始采集”。
      </div>
      <div v-else-if="wizard.step === 2">
        <b>第二步 · 取名</b><br />给这位新成员填一个称呼（全局唯一，之后可改），系统会自动分配一个 <span class="mono">ID</span>。填好点“开始采集”。
      </div>
      <div v-else-if="wizard.step === 3">
        <b>第三步 · 采集中</b><br />云台会自动转动找脸并连续采集多帧，请<b>保持不动、看着镜头</b>约 5～8 秒，直到出现结果。
      </div>
      <div v-else-if="wizard.mode === 'append'">
        <b>第四步 · 完成</b><br />追加结果见下方（样本数已更新）。可“再补一次”继续为同一人采集，或“完成”关闭向导。
      </div>
      <div v-else>
        <b>第四步 · 完成</b><br />登记结果见下方。可“再登记一个”继续录入下一位，或“完成”关闭向导。
      </div>
    </div>

    <div v-if="wizard.step === 2" class="row" style="margin-top: 12px">
      <span class="hint">{{ wizard.mode === 'append' ? '追加对象' : '新成员称呼' }}</span>
      <el-input
        v-model="wizard.name"
        :readonly="wizard.mode === 'append'"
        placeholder="如 fengleiren / 家人昵称"
        size="small"
        style="max-width: 240px"
        @keyup.enter="startCapture"
      />
    </div>
    <div v-if="wizard.result" class="hint" style="margin-top: 10px">{{ wizard.result }}</div>

    <template #footer>
      <el-button v-if="wizard.step === 1" @click="visible = false">取消</el-button>
      <el-button v-if="wizard.step === 1" type="primary" :disabled="!mpStream.running" @click="wizard.step = 2">
        下一步 →
      </el-button>
      <el-button v-if="wizard.step === 2" @click="wizard.step = 1">← 上一步</el-button>
      <el-button
        v-if="wizard.step === 2"
        type="primary"
        :disabled="!wizard.name.trim() || !mpBodyReady"
        @click="startCapture"
      >
        📸 {{ wizard.mode === 'append' ? '开始追加采集' : '开始采集' }}
      </el-button>
      <el-button v-if="wizard.step === 3" type="primary" loading>采集中…</el-button>
      <el-button v-if="wizard.step === 4" @click="again">
        ➕ {{ wizard.mode === 'append' ? '再补一次' : '再登记一个' }}
      </el-button>
      <el-button v-if="wizard.step === 4" type="primary" @click="visible = false">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.wizard-tip {
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 12px 14px;
  line-height: 1.8;
}
</style>
