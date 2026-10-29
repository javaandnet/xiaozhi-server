<script setup>
/**
 * MasterPi 游戏手柄式遥控：左柄管底盘移动、右柄管头部云台、底部一排连续动作（机械臂）。
 * 指令统一走 /api/mcp/call（hub 侧经 peer 链路转发家里执行），与语音链路同一工具口径。
 * 安全：physical 动作分组两步确认（本会话内记住）；按键带冷却防连发；急停免确认。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { callDeviceTool, getSafetyXz, setSafetyXz, shutdownRobotXz, speakRobotVoiceXz, ikJogXz, reconnectRobotXz } from '@/api/mcp';
import { useRobotStatus, providerKeyOf } from '@/composables/useRobotStatus';
import { useKnownDevices } from '@/composables/useDevices';
import { confirmAction } from '@/composables/useApi';
import { useFaceStream, STREAM_MODES } from '@/composables/useFaceStream';
import CameraPreview from './CameraPreview.vue';

const { robotBodies, load: loadBodies } = useRobotStatus();
const { known, load: loadKnown } = useKnownDevices();
const { mpStream, refresh: refreshStream, start: startStream, stop: stopStream, setMode } = useFaceStream();
// 模式说明收进问号 tooltip，不占版面
const CAM_NOTE = '人脸=带检测框（登记/search_face 依赖，其他模式发起登记会自动升回）；普通=不画框最流畅；看家=低频抓帧+变化检测。预览运行时相机由本进程独占，search_face 自动借帧，两者可同时进行。';
const bodyKey = ref('');
const busy = ref(false);
const lastLine = ref('');
// head/armik 默认已授权（与 iOS 遥控页同语义）：开关开＝免确认直接执行；关＝每次动作弹确认
const armed = reactive({ chassis: false, head: true, arm: false, armik: true });
// 右柄「动作授权」开关：只管头部云台 + 手臂微调；连续动作有独立授权开关（默认关＝需确认）
const motionArmed = computed({
  get: () => !!(armed.head && armed.armik),
  set: (v) => { armed.head = armed.armik = v; },
});
// 连续动作（大动作）独立授权开关：开＝免确认直接执行；关＝每次弹确认（确认后自动亮起）
const poseArmed = computed({
  get: () => !!armed.arm,
  set: (v) => { armed.arm = v; },
});
// 底盘安全红线（派侧 robot.allowChassis）：默认锁定，轮子不会真转；解锁须二次确认
const safety = reactive({ allow: null, loading: false, err: '' });

const currentBody = computed(() => robotBodies.value.find((p) => providerKeyOf(p) === bodyKey.value) || null);
const offline = computed(() => !currentBody.value || !currentBody.value.ready);

/* ---------- action catalog（与 /api/robot/action-types 目录同口径） ---------- */

const DRIVE = [
  { key: 'f', dir: 'forward', icon: '▲', label: '前进', area: 'up' },
  { key: 'l', dir: 'left', icon: '◀', label: '左移', area: 'left' },
  { key: 'r', dir: 'right', icon: '▶', label: '右移', area: 'right' },
  { key: 'b', dir: 'backward', icon: '▼', label: '后退', area: 'down' },
  { key: 'tl', dir: 'turn_left', icon: '⟲', label: '原地左转', area: 'tl' },
  { key: 'tr', dir: 'turn_right', icon: '⟳', label: '原地右转', area: 'tr' },
];
const HEAD = [
  { key: 'up', action: 'up', icon: '⤒', label: '抬头', area: 'up' },
  { key: 'left', action: 'left', icon: '⤜', label: '左转', area: 'left' },
  { key: 'right', action: 'right', icon: '⤘', label: '右转', area: 'right' },
  { key: 'down', action: 'down', icon: '⤓', label: '低头', area: 'down' },
];
const ARMS = [
  { pose: 'greet', icon: '🙌', label: '张开手臂' },
  { pose: 'wave', icon: '👋', label: '挥手' },
  { pose: 'nod', icon: '🐦', label: '点头' },
  { pose: 'shake', icon: '🚫', label: '摇头' },
  { pose: 'raise_right', icon: '✋', label: '举手' },
  { pose: 'bow', icon: '🙇', label: '鞠躬' },
  { pose: 'dance', icon: '💃', label: '跳舞' },
  { pose: 'reset', icon: '⤐', label: '手臂归位' },
];

/* ---------- transport ---------- */

async function loadSafety() {
  try {
    const r = await getSafetyXz();
    if (r && r.ok) { safety.allow = !!r.allowChassis; safety.err = ''; }
    else safety.err = (r && r.error) || '读取失败';
  } catch (e) {
    safety.err = e.message;
  }
}

async function toggleSafety(val) {
  if (val) {
    const ok = await confirmAction(
      '解锁底盘：放开硬件侧安全红线（robot.allowChassis=true），轮子将真实转动。\n机器若放在桌上有坠落风险，请先放到地面再解锁。',
      '底盘解锁确认',
    );
    if (!ok) return;
  }
  safety.loading = true;
  try {
    const r = await setSafetyXz(val);
    if (r.ok) {
      safety.allow = !!r.allowChassis;
      ElMessage.success(val ? '底盘已解锁（客户端重启中，约 10 秒后可动）' : '底盘已锁定，轮子拒绝移动');
      setTimeout(loadSafety, 12000); // 客户端重启后回读确认
    } else {
      safety.err = r.error || r.restartError || '设定失败';
      ElMessage.error(`设定失败：${safety.err}`);
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    safety.loading = false;
  }
}

function pickBody() {
  if (!bodyKey.value || !robotBodies.value.some((p) => providerKeyOf(p) === bodyKey.value)) {
    const ready = robotBodies.value.find((p) => p.ready);
    bodyKey.value = ready ? providerKeyOf(ready) : '';
  }
}

async function callTool(tool, args, what) {
  if (offline.value) {
    ElMessage.warning('机器人身体离线（device-MCP 未连接）');
    return;
  }
  busy.value = true;
  try {
    const r = await callDeviceTool({ device: bodyKey.value, tool, args });
    const txt = r.ok ? `✓ ${what}` : `✗ ${what}：${r.error || '失败'}`;
    lastLine.value = `${txt} · ${new Date().toLocaleTimeString()}`;
    if (!r.ok) ElMessage.warning(txt);
    return r;
  } catch (e) {
    lastLine.value = `✗ ${what}：${e.message}`;
    ElMessage.error(e.message);
  } finally {
    busy.value = false;
  }
}

/** 两步确认 + 冷却：同组首次点击弹确认；每次执行后该组按键短暂冷却防连发。 */
const cooling = reactive({ chassis: false, head: false, arm: false, search: false, armik: false });
// 每组独立冷却定时器：共用单 timer 会在跨组连点时 clearTimeout 掉前一组的重置，导致按钮永久置灰
const coolTimers = {};
async function guarded(group, message, fn) {
  if (cooling[group]) return;
  if (!armed[group]) {
    const tip = group === 'chassis'
      ? '（轮动需左侧「允许轮动」开关解锁；机器若放桌上，移动有坠落风险）'
      : group === 'head' || group === 'armik'
        ? '（确认后云台与手臂微调同时授权，右柄开关会同步打开）'
        : group === 'arm'
          ? '（连续动作为大动作，开关关闭时每次均需确认；打开「动作授权」可免确认）'
          : '（确认后本会话不再询问）';
    const ok = await confirmAction(`${message}\n${tip}`, '硬件动作确认');
    if (!ok) return;
    // 连续动作（arm）不自动回写授权：开关关＝每次确认（与 iOS 同语义）；其余组确认后亮起开关
    if (group !== 'arm') armed[group] = true;
    // 云台/微调共享一个授权：确认任意一块 = 两块同时免确认（开关同步亮起）
    if (group === 'head' || group === 'armik') { armed.head = true; armed.armik = true; }
  }
  cooling[group] = true;
  // 底盘指令已异步化（启动即回 ACK，派侧后令为准），冷却只需防手抖连发；其余硬件仍串行执行保持 1.2s
  coolTimers[group] = setTimeout(() => { cooling[group] = false; }, group === 'chassis' ? 400 : 1200);
  await fn();
}

function drive(dir) {
  if (dir === 'stop') return callTool('robot_drive', { direction: 'stop' }, '急停');
  const label = DRIVE.find((d) => d.dir === dir)?.label || dir;
  // 原地转角速度固定，转过的角度正比于时长：转角缩到 1/4（0.6s → 0.15s）
  const dur = dir.startsWith('turn_') ? 0.15 : 0.6;
  return guarded('chassis', `确认执行底盘移动：${label}？`,
    () => callTool('robot_drive', { direction: dir, duration_sec: dur, speed: 0.3 }, `底盘·${label}`));
}

function head(action) {
  const label = HEAD.find((h) => h.action === action)?.label || action;
  return guarded('head', `确认调整云台头部：${label}？`,
    () => callTool('robot_face_align', { action, step: 100 }, `头部·${label}`));
}

function arm(pose) {
  const label = ARMS.find((a) => a.pose === pose)?.label || pose;
  return guarded('arm', `确认执行机械臂动作：${label}？`,
    () => callTool('robot_arm_pose', { pose }, `机械臂·${label}`));
}

/* ---------- 机械臂微调（IK 末端 jog）：基准由 server 统一维护 ----------
 * Web/iOS 共用同一份基准，避免本地跟踪陈旧导致“先跳回某位再动”的危险动作；
 * 连续动作后基准未知，server 会拒绝微调并要求先显式回位。
 * 方向语义→机体系符号（-x=前伸、-y=左移、+z=升高）与安全盒限幅都收口在 server。 */
const IK_DIRS = { up: '升高', down: '降低', forward: '前伸', back: '回收', left: '左移', right: '右移', home: '回位' };
const ikPose = reactive({ x: 0, y: 6, z: 18 });
async function ikMove(dir) {
  const label = IK_DIRS[dir] || dir;
  busy.value = true;
  try {
    const r = await ikJogXz({ body: bodyKey.value, dir });
    const ok = !!r?.ok;
    if (ok && r.pose) Object.assign(ikPose, r.pose);
    const txt = ok
      ? `✓ 机械臂微调·${label} → (${ikPose.x}, ${ikPose.y}, ${ikPose.z})cm`
      : `✗ 机械臂微调·${label}：${r?.error || '失败'}`;
    lastLine.value = `${txt} · ${new Date().toLocaleTimeString()}`;
    if (!ok) ElMessage.warning(txt);
  } catch (e) {
    lastLine.value = `✗ 机械臂微调·${label}：${e.message}`;
    ElMessage.error(e.message);
  } finally {
    busy.value = false;
  }
}
function ikJog(dir) {
  const label = IK_DIRS[dir] || dir;
  return guarded('armik', `确认机械臂微调：${label}？`, () => ikMove(dir));
}

/* ---------- 识人 / 找人（读派侧 JSON 结果里的 person 字段） ---------- */
const whoBusy = ref(false);
const whoLine = ref('');
const findName = ref('');

/** 识人/找人依赖人脸检测：流没跑先拉起（face 档），在跑但不在「人脸识别」档则切回（与登记同口径）。 */
async function ensureFaceMode() {
  if (!mpStream.running) { await startStream('face'); return; }
  if (mpStream.mode !== 'face') await setMode('face');
}

async function callToolResult(tool, args, what) {
  if (offline.value) {
    ElMessage.warning('机器人身体离线（device-MCP 未连接）');
    return null;
  }
  whoBusy.value = true;
  try {
    const r = await callDeviceTool({ device: bodyKey.value, tool, args });
    if (!r.ok) { whoLine.value = `✗ ${what}：${r.error || '失败'}`; return null; }
    try { return JSON.parse(r.result); } catch { return { ok: true }; }
  } catch (e) {
    whoLine.value = `✗ ${what}：${e.message}`;
    return null;
  } finally {
    whoBusy.value = false;
  }
}

/** 识人：只看当前画面认是谁（不运动），robot_face_recognize。 */
async function recognize() {
  await ensureFaceMode();
  const res = await callToolResult('robot_face_recognize', {}, '识人');
  if (!res) return;
  if (res.ok === false) { whoLine.value = `✗ 识人：${res.error || '失败'}`; return; }
  whoLine.value = res.person
    ? `🧑 这是「${res.person}」（${res.person_id || '-'}）`
    : '没匹配到已登记的人（镜头里没脸或陌生人）';
}

/** 找人：巡视寻脸→对准→识人（只动头/躯干不碰轮子）；填了名字则比对结果。 */async function searchPerson() {
  await guarded('search', '确认开始找人？机器人会转动头部/躯干巡视四周（不移动轮子）。', async () => {
    await ensureFaceMode();
    const name = findName.value.trim();
    const res = await callToolResult('robot_search_face', { max_scan_sec: 20 }, '找人');
    if (!res) return;
    if (res.ok === false) { whoLine.value = `✗ 找人：${res.error || '失败'}`; return; }
    if (!res.found) { whoLine.value = '🔍 转了一圈没找到人，可再点「找」重扫'; return; }
    const p = res.person;
    const same = name && p && String(p).toLowerCase() === name.toLowerCase();
    if (!name) {
      whoLine.value = p ? `✓ 找到人：是「${p}」，已对准停下` : '✓ 找到人（陌生人），已对准停下';
    } else if (same) {
      whoLine.value = `✓ 找到「${name}」，已停止并对准镜头`;
    } else {
      whoLine.value = p && p !== name
        ? `找到的那个人是「${p}」，不是「${name}」（已停在 TA 面前，可再点「找」重扫）`
        : `找到一个人但没认出是谁，不是「${name}」（可再点「找」重扫）`;
    }
  });
}

/* ---------- 语音播报：目标小智设备不手选，按一一对应绑定关系（settings.robot.body）倒查 ----------
 * 后端 /api/masterpi/speak 传 body 键在线反查；前端只展示绑定了当前身体的设备名。 */
const speakText = ref('');
const speakBusy = ref(false);
// 倒查绑定到当前身体的小智设备：展示只关心在线与否，不暴露 MAC
const boundVoice = computed(() => {
  const k = String(bodyKey.value || '').toLowerCase();
  if (!k) return null;
  return (known.items || []).find((it) => it.robot && it.robot_body && String(it.robot_body).toLowerCase() === k) || null;
});
const voiceOnline = computed(() => !!(boundVoice.value && Number(boundVoice.value.online) === 1));
async function speakPush() {
  const text = speakText.value.trim();
  if (!text) { ElMessage.warning('先输入要播报的文字'); return; }
  speakBusy.value = true;
  try {
    const r = await speakRobotVoiceXz({ text, body: bodyKey.value || 'masterpi-0001' });
    if (r.ok) {
      speakText.value = '';
      lastLine.value = `✓ 播报已排队 → ${r.deviceId || `${r.devices} 台绑定设备`} · ${new Date().toLocaleTimeString()}`;
      ElMessage.success('播报指令已发出，设备唤醒后朗读');
    } else {
      ElMessage.error(r.error || '播报失败');
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    speakBusy.value = false;
  }
}

/* 软关机：SSH shutdown -h，比直接断电安全（SD 卡文件系统）；两步确认。 */
const shuttingDown = ref(false);
/* 重连身体：server 重启后派侧可能持有僵尸 TCP 假在线（相机直连正常、云台却无法连接），
   SSH 重启派 client 触发真正重连。 */
const reconnecting = ref(false);
async function reconnectBody() {
  reconnecting.value = true;
  try {
    const r = await reconnectRobotXz();
    if (r.ok) {
      ElMessage.success('已重启身体客户端，等待重新接入…');
      setTimeout(() => loadBodies().then(pickBody), 6000);
    } else {
      ElMessage.error(`重连失败：${r.error || '未知错误'}`);
    }
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    reconnecting.value = false;
  }
}
async function shutdownRobot() {
  const ok = await confirmAction(
    '确认关机？系统将安全停止后断电，需按设备上物理电源键才能重新开机。\n（建议先停止相机预览与移动动作）\n电池供电时：关机后请再关闭扩展板开关，否则待机电流会持续放干电池致过放无法开机。',
    '机器人关机确认',
  );
  if (!ok) return;
  shuttingDown.value = true;
  try {
    const r = await shutdownRobotXz();
    if (r.ok) {
      ElMessage.success('关机指令已发出，设备数十秒内停止；再开机需按物理电源键');
    } else {
      ElMessage.error(`关机失败：${r.error || '未知错误'}`);
      shuttingDown.value = false;
    }
  } catch (e) {
    ElMessage.error(e.message);
    shuttingDown.value = false;
  }
}

let timer = null;
let statusTimer = null;
/** 进页自动拉起预览：派重启后 vision_stream 随系统丢失，电池开机也应看到画面（仅身体在线时）。 */
async function autoOpenPreview() {
  if (offline.value) return;
  await refreshStream();
  if (!mpStream.running && !mpStream.loading) await startStream('face');
}
onMounted(() => {
  loadSafety();
  loadKnown(); // 播报行展示绑定小智设备的在线状态（10s 轮询同步）
  loadBodies().then(() => { pickBody(); autoOpenPreview(); });
  timer = setInterval(() => { loadBodies().then(pickBody); loadKnown(); }, 10000);
  // 轻量状态轮询：同步 frameStatus，断流时自动亮出「重连摄像头」告警（不碰 imgSrc 不打断画面）
  statusTimer = setInterval(() => { refreshStream(false); }, 20000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  if (statusTimer) clearInterval(statusTimer);
  Object.values(coolTimers).forEach(clearTimeout);
});
</script>

<template>
  <div class="pad">
    <div class="pad-bar">
      <el-tag size="small" :type="offline ? 'danger' : 'success'" effect="plain">
        {{ currentBody ? `${currentBody.name} · ${currentBody.toolCount} 工具` : '无在线身体' }}
      </el-tag>
      <el-button size="small" text :loading="busy" @click="loadBodies().then(pickBody)">⟳</el-button>
      <el-button v-if="offline" size="small" type="warning" plain :loading="reconnecting" @click="reconnectBody">🔌 重连身体</el-button>
      <span class="bar-sep" />
      <b>📹</b>
      <el-tag size="small" :type="mpStream.running ? 'success' : 'info'" effect="plain">
        {{ mpStream.running ? '运行中' : '未运行' }}
      </el-tag>
      <el-radio-group
        :model-value="mpStream.mode"
        size="small"
        :disabled="mpStream.modeChanging"
        @update:model-value="setMode"
      >
        <el-radio-button v-for="m in STREAM_MODES" :key="m.value" :value="m.value">{{ m.label }}</el-radio-button>
      </el-radio-group>
      <el-button size="small" type="primary" :loading="mpStream.loading" :disabled="mpStream.running" @click="startStream()">▶ 启动</el-button>
      <el-button size="small" :loading="mpStream.loading" :disabled="!mpStream.running" @click="stopStream">■ 停止</el-button>
      <el-button size="small" text :loading="mpStream.loading" @click="refreshStream(true)">⟳</el-button>
      <a v-if="mpStream.url" :href="mpStream.url" target="_blank" class="hint">独立窗口 ↗</a>
      <el-tooltip :content="CAM_NOTE" placement="bottom" popper-style="max-width: 340px">
        <span class="cam-help">?</span>
      </el-tooltip>
      <span class="hint">{{ (STREAM_MODES.find((m) => m.value === mpStream.mode) || {}).hint }}</span>
      <span style="flex: 1" />
      <el-button size="small" type="danger" plain :loading="shuttingDown" :disabled="offline || shuttingDown" @click="shutdownRobot">
        ⏻ 关机
      </el-button>
      <span class="hint mono">{{ lastLine }}</span>
    </div>

    <div class="pad-body">
      <!-- 左柄：底盘 -->
      <div class="stick">
        <div class="stick-title">
          底盘
          <el-tag size="small" :type="safety.allow ? 'warning' : 'success'" effect="dark">
            {{ safety.allow === null ? (safety.err ? '状态未知' : '读取中…') : safety.allow ? '🔓 已解锁·允许移动' : '🔒 安全锁定·不会移动' }}
          </el-tag>
          <el-switch
            :model-value="!!safety.allow"
            size="small"
            active-text="允许轮动"
            :loading="safety.loading"
            style="margin-left: auto"
            @update:model-value="toggleSafety"
          />
        </div>
        <div class="dpad">
          <button v-for="d in DRIVE" :key="d.key" class="pad-btn" :class="'pos-' + d.area"
            :disabled="busy || cooling.chassis || offline" @click="drive(d.dir)">
            <span class="ico">{{ d.icon }}</span><span class="cap">{{ d.label }}</span>
          </button>
          <button class="pad-btn center estop" :disabled="offline" @click="drive('stop')">
            <span class="ico">⏹</span><span class="cap">急停</span>
          </button>
        </div>
      </div>

      <!-- 中列：摄像头实时预览（状态由 useFaceStream 单例承载） -->
      <div class="stick cam-col">
        <CameraPreview />
        <div class="who-row">
          <el-button size="small" :loading="whoBusy" :disabled="offline" @click="recognize">🧑 识人</el-button>
          <el-input v-model="findName" size="small" placeholder="名字（空=任何人）" clearable class="who-name" @keyup.enter="searchPerson" />
          <el-button size="small" :loading="whoBusy" :disabled="offline" @click="searchPerson">🔍 找</el-button>
        </div>
        <div v-if="whoLine" class="hint who-result">{{ whoLine }}</div>
        <div class="who-row speak-row">
          <el-tag size="large" :type="voiceOnline ? 'success' : 'warning'" effect="plain" class="speak-bind">
            🔗 {{ boundVoice ? (voiceOnline ? '小智设备在线' : '小智设备离线') : '未绑定小智设备' }}
          </el-tag>
          <el-input v-model="speakText" size="large" placeholder="要播报的文字…" clearable class="speak-text" @keyup.enter="speakPush" />
          <el-button size="large" type="primary" :loading="speakBusy" :disabled="!voiceOnline" @click="speakPush">🔊 播报</el-button>
        </div>
      </div>

      <!-- 右柄：头部云台 + 机械臂末端微调（IK） -->
      <div class="stick">
        <div class="stick-title">
          头部云台
          <el-switch v-model="motionArmed" size="small" active-text="🔓 动作授权" style="margin-left: auto" />
        </div>
        <div class="dpad">
          <button v-for="h in HEAD" :key="h.key" class="pad-btn" :class="'pos-' + h.area"
            :disabled="busy || cooling.head || offline" @click="head(h.action)">
            <span class="ico">{{ h.icon }}</span><span class="cap">{{ h.label }}</span>
          </button>
          <button class="pad-btn center" :disabled="busy || cooling.head || offline" @click="head('center')">
            <span class="ico">◎</span><span class="cap">回中</span>
          </button>
        </div>
        <div class="stick-title ik-title">手臂微调 <b class="ik-xyz">({{ ikPose.x }}, {{ ikPose.y }}, {{ ikPose.z }})cm</b></div>
        <!-- 相反动作同列上下配对：升/降、前伸/回收、左/右，回位居中 -->
        <div class="ik-grid">
          <button class="pad-btn" :disabled="busy || cooling.armik || offline" @click="ikJog('up')"><span class="ico">⬆️</span><span class="cap">升高</span></button>
          <button class="pad-btn" :disabled="busy || cooling.armik || offline" @click="ikJog('forward')"><span class="ico">↗️</span><span class="cap">前伸</span></button>
          <button class="pad-btn" :disabled="busy || cooling.armik || offline" @click="ikJog('left')"><span class="ico">⬅️</span><span class="cap">左移</span></button>
          <button class="pad-btn" :disabled="busy || cooling.armik || offline" @click="ikJog('down')"><span class="ico">⬇️</span><span class="cap">降低</span></button>
          <button class="pad-btn" :disabled="busy || cooling.armik || offline" @click="ikJog('back')"><span class="ico">↙️</span><span class="cap">回收</span></button>
          <button class="pad-btn" :disabled="busy || cooling.armik || offline" @click="ikJog('right')"><span class="ico">➡️</span><span class="cap">右移</span></button>
          <button class="pad-btn ik-home" :disabled="busy || cooling.armik || offline" @click="ikJog('home')"><span class="ico">⌂</span><span class="cap">回位</span></button>
        </div>
      </div>
    </div>

    <!-- 底部：连续动作（机械臂预置动作宏） -->
    <div class="acts">
      <div class="stick-title">连续动作 <span class="hint">机械臂预置动作宏，单次点击整段执行</span>
        <el-switch v-model="poseArmed" size="small" active-text="🔓 动作授权" style="margin-left: auto" />
      </div>
      <div class="acts-row">
        <button v-for="a in ARMS" :key="a.pose" class="act-btn"
          :disabled="busy || cooling.arm || offline" @click="arm(a.pose)">
          <span class="ico">{{ a.icon }}</span><span class="cap">{{ a.label }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pad { display: flex; flex-direction: column; gap: 10px; }
.pad-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bar-sep { width: 1px; height: 18px; background: var(--el-border-color); margin: 0 2px; }
.cam-help { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px;
  border-radius: 50%; border: 1px solid var(--el-border-color); font-size: 11px; cursor: help;
  color: var(--el-text-color-secondary); }
.hint { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: var(--el-font-family-mono, monospace); }
.pad-body { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(340px, 1.6fr) minmax(260px, 1fr); gap: 16px; align-items: start; }
@media (max-width: 1100px) { .pad-body { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); } }
.cam-col { padding: 8px 8px 10px; }
.who-row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
.who-name { width: 130px; flex-shrink: 0; }
.speak-bind { flex-shrink: 0; }
.speak-text { flex: 1; min-width: 120px; }
/* 播报行加大：输入文字看得清，目标状态一眼确认 */
.speak-row { margin-top: 10px; }
.speak-row .speak-text :deep(.el-input__inner) { font-size: 16px; }
.speak-row .el-button { font-size: 15px; }
.who-result { margin-top: 4px; line-height: 1.5; }
.ik-title { margin-top: 16px; }
.ik-xyz { font-weight: 600; color: var(--el-text-color-secondary); }
.ik-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.ik-grid .pad-btn { width: 100%; border-radius: 12px; }
.ik-grid .ik-home { grid-column: 2; }
.stick { background: var(--el-fill-color-lighter); border: 1px solid var(--el-border-color-lighter); border-radius: 14px; padding: 12px 14px 18px; }
.stick-title { font-weight: 600; font-size: 13px; margin-bottom: 10px; display: flex; gap: 8px; align-items: baseline; }

/* 十字键盘：3x3 网格，中央急停/回中 */
.dpad { display: grid; grid-template-areas: "tl up tr" "left center right" ". down ."; gap: 8px; justify-items: center; align-items: center; width: max-content; margin: 0 auto; }
.pos-up { grid-area: up; } .pos-down { grid-area: down; } .pos-left { grid-area: left; }
.pos-right { grid-area: right; } .pos-tl { grid-area: tl; } .pos-tr { grid-area: tr; }
.center { grid-area: center; }

.pad-btn { width: 72px; height: 72px; border-radius: 50%; border: 1px solid var(--el-border-color); cursor: pointer;
  background: linear-gradient(180deg, var(--el-bg-color), var(--el-fill-color-light));
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  color: var(--el-text-color-primary); transition: transform 0.06s, box-shadow 0.12s; user-select: none; }
.pad-btn .ico { font-size: 20px; line-height: 1; }
.pad-btn .cap { font-size: 11px; }
.pad-btn:hover:not(:disabled) { box-shadow: 0 0 0 3px var(--el-color-primary-light-8); }
.pad-btn:active:not(:disabled) { transform: scale(0.92); }
.pad-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pad-btn.estop { background: linear-gradient(180deg, var(--el-color-danger-light-9), var(--el-color-danger-light-7)); border-color: var(--el-color-danger); color: var(--el-color-danger); }
.pad-btn.estop:active:not(:disabled) { transform: scale(0.9); }

/* 底部连续动作：胶囊键 */
.acts { background: var(--el-fill-color-lighter); border: 1px solid var(--el-border-color-lighter); border-radius: 14px; padding: 12px 14px 16px; }
.acts-row { display: flex; flex-wrap: wrap; gap: 10px; }
.act-btn { display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 999px;
  border: 1px solid var(--el-border-color); cursor: pointer; font-size: 13px;
  background: linear-gradient(180deg, var(--el-bg-color), var(--el-fill-color-light));
  color: var(--el-text-color-primary); transition: transform 0.06s, box-shadow 0.12s; user-select: none; }
.act-btn .ico { font-size: 15px; }
.act-btn:hover:not(:disabled) { box-shadow: 0 0 0 3px var(--el-color-primary-light-8); }
.act-btn:active:not(:disabled) { transform: scale(0.94); }
.act-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
