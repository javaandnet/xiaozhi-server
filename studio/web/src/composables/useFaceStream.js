/**
 * On-demand MJPEG preview on the Pi — module-level singleton so the camera card and
 * the face enrollment wizard show the very same stream.
 */
import { reactive } from 'vue';
import { getStreamStatus, startStream, stopStream } from '@/api/masterpi';

const mpStream = reactive({ loading: false, running: false, url: '', imgSrc: '' });

function stamp(url) {
  return `${url}stream?_=${Date.now()}`;
}

export function useFaceStream() {
  async function refresh() {
    try {
      const r = await getStreamStatus();
      mpStream.running = !!r.running;
      mpStream.url = r.url || '';
      mpStream.imgSrc = mpStream.running ? stamp(mpStream.url) : '';
    } catch (e) {
      // Status polling is best-effort: keep the last known state.
      console.warn('[useFaceStream] status failed:', e.message);
    }
  }

  async function start() {
    mpStream.loading = true;
    try {
      const r = await startStream();
      if (r.ok) {
        mpStream.running = true;
        mpStream.url = r.url || mpStream.url;
        mpStream.imgSrc = stamp(mpStream.url);
        ElMessage.success('实时画面已启动');
      } else {
        ElMessage.error(r.error || '启动失败');
      }
    } catch (e) {
      ElMessage.error(String(e?.message || e));
    } finally {
      mpStream.loading = false;
    }
  }

  async function stop() {
    mpStream.loading = true;
    try {
      const r = await stopStream();
      mpStream.running = false;
      mpStream.imgSrc = '';
      ElMessage.success(r.ok ? '已停止并释放相机' : '停止命令已发送');
    } catch (e) {
      ElMessage.error(String(e?.message || e));
    } finally {
      mpStream.loading = false;
    }
  }

  return { mpStream, refresh, start, stop };
}
