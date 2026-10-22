/**
 * Firmware workbench state and actions — module-level singleton so the build log
 * keeps streaming (SSE) even while the user navigates to another page.
 */
import { computed, reactive, ref, watch } from 'vue';
import {
  buildEventsUrl,
  checkOfficialRelease,
  deleteFirmware,
  detectBoard,
  flashUsb,
  getBoards,
  getRecentDevices,
  installFirmware,
  startBuild,
  syncSource,
} from '@/api/firmware';
import { getFirmwareList } from '@/api/studio';
import { confirmAction, useApi } from './useApi';
import { useEnv } from './useEnv';
import { mb } from './useFormat';

const SEP = '|||';
const DEFAULT_DETECT_HINT = '点检测：优先读 USB 描述符（序列号=MAC）精确识别当前连接设备。';

const { env, load: loadEnv } = useEnv();
const { run } = useApi();

const devices = ref([]);
const boards = ref([]);
const boardFilter = ref('');
const boardSel = ref('');
const rel = ref(null);
const fwList = ref([]);
const fwDir = ref('');
const portSel = ref('');
const logLines = ref([]);
const flashLines = ref([]);
const artifact = ref(null);
const detectHint = ref(DEFAULT_DETECT_HINT);
const syncRef = ref('');
const flashSize = ref('16MB');
const ww = reactive({ mode: 'default', word: '', display: '', threshold: 20 });
const flags = reactive({
  detecting: false,
  checking: false,
  syncing: false,
  building: false,
  installing: false,
  flashing: false,
});

let currentJob = null;
let watching = true;
let events = null;

function cmpVer(a, b) {
  const pa = String(a).match(/\d+/g)?.map(Number) || [];
  const pb = String(b).match(/\d+/g)?.map(Number) || [];
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function push(arr, text, cls = '') {
  arr.value.push({ t: text, c: cls });
  if (arr.value.length > 3000) arr.value.shift();
}

function boardParts(value = boardSel.value) {
  return String(value || '').split(SEP);
}

export function useFirmware() {
  const boardOptions = computed(() => {
    const f = boardFilter.value.trim().toLowerCase();
    return boards.value
      .filter(
        (b) =>
          !f ||
          (b.type + b.name + (b.full_name || '') + (b.display_name || '')).toLowerCase().includes(f),
      )
      .map((b) => ({
        value: [b.board, b.name, b.type, b.target, b.config].join(SEP),
        label: `${b.type}${b.display_name && b.display_name !== b.type ? ' — ' + b.display_name : ''} (${b.target})`,
      }));
  });

  const boardMeta = computed(() => {
    if (!boardSel.value) return '';
    const [board, name, type, target, config] = boardParts();
    return `dir=${board} · name=${name} · type=${type} · target=${target} · ${config}`;
  });

  const relBehind = computed(
    () => rel.value?.latest && env.repoVersion && cmpVer(rel.value.latest, env.repoVersion) > 0,
  );

  async function loadBoards() {
    const r = await run(() => getBoards());
    if (!r) return;
    boards.value = r.items || [];
    if (r.error) push(logLines, '板型加载错误：' + r.error, 'bad');
  }

  async function loadFirmware() {
    const r = await run(() => getFirmwareList());
    if (!r) return;
    fwList.value = r.items || [];
    fwDir.value = r.dir || fwDir.value;
  }

  async function refreshPorts() {
    await loadEnv();
    if (!env.ports.includes(portSel.value)) portSel.value = env.ports[0] || '';
  }

  async function checkRelease() {
    const type = boardParts()[2];
    flags.checking = true;
    try {
      rel.value = await checkOfficialRelease(type);
    } catch (e) {
      rel.value = { error: e.message };
    } finally {
      flags.checking = false;
    }
  }

  // Switching board re-checks the official release; debounce keeps GitHub quiet.
  let relTimer = null;
  watch(boardSel, (v) => {
    if (!v) return;
    clearTimeout(relTimer);
    relTimer = setTimeout(checkRelease, 400);
  });

  async function loadSyncDefault() {
    // Pre-fill the sync ref with the newest official tag (offline/failed stays empty = git pull).
    try {
      const r = await checkOfficialRelease();
      if (r.latest && !syncRef.value) syncRef.value = `v${r.latest}`;
    } catch (e) {
      console.warn('[useFirmware] release probe failed:', e.message);
    }
  }

  async function detect() {
    flags.detecting = true;
    detectHint.value = '检测中…';
    try {
      const [d, dv] = await Promise.all([detectBoard(), getRecentDevices()]);
      devices.value = dv.items || [];
      detectHint.value = d.hint;
      if (d.ports) env.ports = d.ports;
      if (d.matched) {
        const b = d.matched.board;
        boardFilter.value = '';
        boardSel.value = [b.board, b.name, b.type, b.target, b.config].join(SEP);
        push(logLines, `✓ 已自动选中板型：${b.type}（识别方式 ${d.matched.via}）`, 'ok');
      }
    } finally {
      flags.detecting = false;
    }
  }

  async function sync() {
    const target = syncRef.value.trim();
    const question = target
      ? `将 checkout 到 ${target}（会改变仓库状态），确认？`
      : '将执行 git pull --ff-only + submodule 更新，确认？';
    if (!(await confirmAction(question, 'git 同步确认'))) return;
    flags.syncing = true;
    push(logLines, `— git 同步开始（ref=${target || 'pull'}）—`, 'blue');
    await run(async () =>
      syncSource(target, (o) => {
        if (o.done) {
          push(logLines, o.ok ? '✓ 同步完成' : `✗ 同步失败 code=${o.code}`, o.ok ? 'ok' : 'bad');
          if (o.ok) loadEnv();
        } else if (o.line) push(logLines, o.line);
      }),
    );
    flags.syncing = false;
  }

  async function build() {
    const [board, name, kind] = boardParts();
    if (!board) {
      ElMessage.warning('请先选择板型');
      return;
    }
    logLines.value = [];
    artifact.value = null;
    flags.building = true;
    watching = true;
    push(logLines, `— 开始编译 ${kind} (${board} --name ${name}) —`, 'blue');
    const r = await run(() =>
      startBuild({
        board,
        name,
        type: kind,
        otaUrl: env.otaUrl,
        otaUrlFallback: env.otaUrlFallback,
        flashSize: flashSize.value,
        wakeWord:
          ww.mode === 'custom' && ww.word.trim()
            ? { word: ww.word.trim(), display: ww.display.trim(), threshold: ww.threshold }
            : null,
      }),
    );
    if (!r) {
      flags.building = false;
      return;
    }
    if (r.error) {
      push(logLines, r.error, 'bad');
      flags.building = false;
      return;
    }
    currentJob = r.jobId;
  }

  async function stopWatching() {
    if (
      !(await confirmAction('仅停止页面日志跟踪，后台编译任务会继续执行，稍后可重新查看进度。确认停止跟踪？', '停止跟踪'))
    ) {
      return;
    }
    watching = false;
    flags.building = false;
    push(logLines, '（前端已停止追加，后台任务仍在进行）', 'warn');
  }

  async function install(confirm = false) {
    const a = artifact.value;
    if (!a) return;
    flags.installing = true;
    try {
      const r = await installFirmware({ source: a.source, model: a.type, version: a.version, confirm });
      if (r.needConfirm) {
        if (await confirmAction(r.message, '覆盖确认')) await install(true);
        return;
      }
      if (r.error) {
        ElMessage.error('安装失败：' + r.error);
        return;
      }
      push(logLines, `✓ 已安装到 OTA 目录：${r.dest}（${mb(r.size)} MB）`, 'ok');
      ElMessage.success('安装成功！设备下次 OTA 请求时将自动升级。');
      artifact.value = null;
      await loadFirmware();
    } finally {
      flags.installing = false;
    }
  }

  async function removeFirmware(filename) {
    if (!(await confirmAction(`删除 ${filename}？`, '删除确认'))) return;
    const r = await run(() => deleteFirmware(filename));
    if (!r) return;
    if (r.ok) await loadFirmware();
    else ElMessage.error(r.error || r.message || '删除失败');
  }

  async function flash() {
    const [board, name] = boardParts();
    if (!portSel.value) {
      ElMessage.warning('未选择串口');
      return;
    }
    if (
      !(await confirmAction(
        `USB 烧录会直接改写 ${portSel.value} 上设备的固件（板型 ${name || '?'}）。设备需可烧录。确认继续？`,
        '烧录确认',
      ))
    ) {
      return;
    }
    flags.flashing = true;
    flashLines.value = [];
    await run(async () =>
      flashUsb({ port: portSel.value, board, name }, (o) => {
        if (o.done) push(flashLines, o.ok ? '✓ 烧录完成' : `✗ 烧录失败 code=${o.code}`, o.ok ? 'ok' : 'bad');
        else if (o.line) push(flashLines, o.line);
      }),
    );
    flags.flashing = false;
  }

  /** One long-lived EventSource: build logs survive page switches. */
  function openEvents() {
    if (events) return;
    events = new EventSource(buildEventsUrl());
    events.addEventListener('build:log', (e) => {
      const d = JSON.parse(e.data);
      if (watching && d.id === currentJob) push(logLines, d.line);
    });
    events.addEventListener('build:done', (e) => {
      const d = JSON.parse(e.data);
      if (d.id !== currentJob) return;
      flags.building = false;
      if (d.status === 'success') {
        const kind = boardParts()[2] || d.type;
        artifact.value = { source: d.artifact, type: kind, version: d.version };
        push(logLines, `✓ 编译成功：${kind}_${d.version}.bin → ${d.artifact}`, 'ok');
      } else {
        push(logLines, `✗ 编译失败：${d.error || '未知'}`, 'bad');
      }
    });
  }

  return {
    devices,
    boards,
    boardFilter,
    boardSel,
    boardOptions,
    boardMeta,
    rel,
    relBehind,
    fwList,
    fwDir,
    portSel,
    flashSize,
    logLines,
    flashLines,
    artifact,
    detectHint,
    syncRef,
    ww,
    flags,
    push,
    loadBoards,
    loadFirmware,
    refreshPorts,
    checkRelease,
    loadSyncDefault,
    detect,
    sync,
    build,
    stopWatching,
    install,
    removeFirmware,
    flash,
    openEvents,
  };
}
