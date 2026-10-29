<script setup>
/**
 * 摄像头画面列：仅承载 MJPEG 预览图与看家子面板（启停控制另有顶部状态行）。
 * 未运行时在画面占位区中央提供启动按钮，不用回顶部找。
 * 状态由 useFaceStream 模块级单例承载，与登记向导共享。
 */
import { useFaceStream } from '@/composables/useFaceStream';
import RobotWatchPanel from './RobotWatchPanel.vue';

const { mpStream, noFrame, start: startStream, reconnect } = useFaceStream();
</script>

<template>
  <div class="cam">
    <div v-if="mpStream.running && noFrame" class="cam-stalled">
      <span class="stalled-txt">⚠ 相机取不到帧（可能 USB 掉盘），可强制重连</span>
      <el-button size="small" type="warning" :loading="mpStream.loading" @click="reconnect">🔄 重连摄像头</el-button>
    </div>
    <img
      v-if="mpStream.running"
      :src="mpStream.imgSrc"
      class="cam-frame"
      alt="stream"
    />
    <div v-else class="cam-idle">
      <div class="hint">预览未启动</div>
      <el-button size="small" type="primary" :loading="mpStream.loading" @click="startStream(mpStream.mode)">
        ▶ 启动摄像头
      </el-button>
    </div>
    <RobotWatchPanel v-if="mpStream.mode === 'watch'" />
  </div>
</template>

<style scoped>
.cam { display: flex; flex-direction: column; gap: 6px; text-align: center; }
.cam-frame { max-width: 100%; border: 1px solid var(--el-border-color); border-radius: 6px; }
.cam-idle {
  aspect-ratio: 4 / 3; display: flex; flex-direction: column; gap: 10px;
  align-items: center; justify-content: center;
  border: 1px dashed var(--el-border-color); border-radius: 6px;
}
.cam-stalled {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: 6px 10px; border: 1px solid var(--el-color-warning); border-radius: 6px;
  background: var(--el-color-warning-light-9);
}
.stalled-txt { font-size: 12px; color: var(--el-color-warning); }
.hint { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
