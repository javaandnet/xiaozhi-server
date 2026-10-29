/**
 * On-demand MJPEG preview on the Pi — module-level singleton so the camera card and
 * the face enrollment wizard show the very same stream.
 *
 * Stream control goes through the main channel /api/masterpi/stream/*（云端 hub 侧经
 * peer 链路转发家里执行）；画面源按 /health 的 peer.role 选择：
 *   branch/本地 → Pi LAN 直连流；hub（外出）→ 经云端帧中继（约 2.5fps，会话 cookie 鉴权）。
 * 三档模式：face 人脸识别(带框) / preview 普通(最流畅) / watch 看家(低频+变化检测)。
 */
import { computed, reactive } from 'vue';
import { getStreamStatusXz, startStreamXz, stopStreamXz, setStreamModeXz } from '@/api/mcp';
import { getHealth } from '@/api/device';
import { NS } from '@/api/http';

export const STREAM_MODES = [
  { value: 'face', label: '人脸识别', hint: '带检测框·~10fps·登记/search_face 依赖' },
  { value: 'preview', label: '普通', hint: '不检测·最流畅·~20fps' },
  { value: 'watch', label: '看家', hint: '低频抓帧·变化检测事件' },
];

const mpStream = reactive({
  loading: false, running: false, url: '', imgSrc: '', peerRole: '',
  mode: 'face', modeChanging: false, frameStatus: '',
});
// 流进程活着但抓不到相机帧（如 USB 掉盘）：派侧在 /meta.status 报 "no frame (retrying)"
const noFrame = computed(() => /no frame/i.test(mpStream.frameStatus));

function stamp(url) {
  return mpStream.peerRole === 'hub'
    ? `${NS}/api/peer/camera/feed?_=${Date.now()}`
    : `${url}stream?_=${Date.now()}`;
}

export function useFaceStream() {
  /** force=true （手动 ⟳）重拉画面；定时轮询不碰 imgSrc，避免打断进行中的 MJPEG。 */
  async function refresh(force = false) {
    try {
      const h = await getHealth();
      mpStream.peerRole = h?.peer?.role || '';
    } catch { /* best effort：取不到 role 按本地直连处理 */ }
    try {
      const r = await getStreamStatusXz();
      mpStream.running = !!r.running;
      mpStream.url = r.url || '';
      mpStream.frameStatus = r.status || '';
      if (r.mode) mpStream.mode = r.mode; // 派侧实况为准（/frames 会自动升级 face）
      if (!mpStream.running) mpStream.imgSrc = '';
      else if (force || !mpStream.imgSrc || mpStream.lastUrl !== mpStream.url) {
        mpStream.imgSrc = stamp(mpStream.url);
        mpStream.lastUrl = mpStream.url;
      }
    } catch (e) {
      // Status polling is best-effort: keep the last known state.
      console.warn('[useFaceStream] status failed:', e.message);
    }
  }

  /** mode 显式指定时为该次启动强制此档(登记向导用);否则用当前选择档。 */
  async function start(mode) {
    const forced = STREAM_MODES.some((m) => m.value === mode) ? mode : null;
    mpStream.loading = true;
    try {
      const r = await startStreamXz(forced || mpStream.mode);
      if (r.ok) {
        mpStream.running = true;
        mpStream.mode = r.mode || forced || mpStream.mode;
        mpStream.url = r.url || mpStream.url;
        mpStream.imgSrc = stamp(mpStream.url);
        mpStream.lastUrl = mpStream.url;
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

  /** 运行中即时切档；未运行则只记住选择（启动时随 start 带上）。 */
  async function setMode(mode) {
    const prev = mpStream.mode;
    mpStream.mode = mode;
    if (!mpStream.running || mode === prev) return;
    mpStream.modeChanging = true;
    try {
      const r = await setStreamModeXz(mode);
      if (!r.ok) ElMessage.error(r.error || '模式切换失败');
      else { mpStream.imgSrc = stamp(mpStream.url); mpStream.lastUrl = mpStream.url; } // 重启流画面，立刻反映新模式
    } catch (e) {
      ElMessage.error(String(e?.message || e));
      mpStream.mode = prev;
    } finally {
      mpStream.modeChanging = false;
    }
  }

  async function stop() {
    mpStream.loading = true;
    try {
      const r = await stopStreamXz();
      mpStream.running = false;
      mpStream.imgSrc = '';
      ElMessage.success(r.ok ? '已停止并释放相机' : '停止命令已发送');
    } catch (e) {
      ElMessage.error(String(e?.message || e));
    } finally {
      mpStream.loading = false;
    }
  }

  /** 重连摄像头：重启派侧流进程，重新占用相机（USB 掉盘/no frame 卡死时手动自愈入口）。 */
  async function reconnect() {
    await stop();
    await start(mpStream.mode);
  }

  return { mpStream, noFrame, refresh, start, stop, setMode, reconnect };
}
