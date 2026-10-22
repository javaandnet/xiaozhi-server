/**
 * Face library (recognition / enrollment / login).
 *
 * Listing, renaming and deleting go through the studio SSH face_db CLI; enrolling,
 * logging in and panning the camera are device-MCP tool calls on the robot body.
 * Module-level singleton: the table, the wizard and the login switch share one copy.
 */
import { computed, reactive } from 'vue';
import {
  deleteFace as deleteFaceApi,
  listFaces,
  renameFace,
  setFaceLogin,
  setFaceThreshold,
} from '@/api/masterpi';
import { callDeviceTool } from '@/api/mcp';
import { useMasterPi } from './useMasterPi';
import { useRobotStatus, providerKeyOf } from './useRobotStatus';
import { confirmAction } from './useApi';

const FACE_ID_RE = /^p_[abcdefghjkmnpqrstuvwxyz23456789]{4,16}$/;

const faces = reactive({
  loading: false,
  saving: false,
  enrolling: false,
  logging: false,
  switching: false,
  persons: [],
  currentLogin: null,
  loginEnabled: false,
  threshold: 0.363,
  enrollName: '',
  enrollId: '',
  result: '',
});

/** The MCP tool result is a JSON string on the wire; parse defensively. */
function payload(result) {
  if (typeof result !== 'string') return result ?? null;
  try {
    return JSON.parse(result);
  } catch (e) {
    console.debug('[useFaces] tool result is not JSON:', e.message);
    return null;
  }
}

function errOf(e) {
  return String(e?.message || e);
}

export function useFaces() {
  const { mp } = useMasterPi();
  const { robotBodies } = useRobotStatus();

  const mpBodyReady = computed(() => robotBodies.value.some((p) => p.ready));

  // Prefer an online robot body; fall back to the Pi itself.
  function faceDevice() {
    const body = robotBodies.value.find((p) => p.ready) || robotBodies.value[0];
    return body ? providerKeyOf(body) : mp.deviceId || 'masterpi-0001';
  }

  function requireBody(action) {
    if (mpBodyReady.value) return true;
    ElMessage.error(`身体离线，无法${action}`);
    return false;
  }

  async function refresh() {
    faces.loading = true;
    try {
      const r = await listFaces();
      if (r.ok) {
        faces.persons = r.persons || [];
        faces.currentLogin = r.current_login || null;
        faces.loginEnabled = !!r.face_login_enabled;
        if (typeof r.threshold === 'number') faces.threshold = r.threshold;
      } else {
        ElMessage.error(r.error || '人脸库读取失败');
      }
    } catch (e) {
      ElMessage.error(errOf(e));
    } finally {
      faces.loading = false;
    }
  }

  function validId(id) {
    if (!id || FACE_ID_RE.test(id)) return true;
    ElMessage.error('ID 格式应为 p_ 开头 4~16 位小写字母数字（不含 i/l/o/0/1）');
    return false;
  }

  async function enroll() {
    const name = faces.enrollName.trim();
    if (!name) return;
    const id = faces.enrollId.trim();
    if (!validId(id)) return;
    faces.enrolling = true;
    faces.result = '';
    try {
      const args = { name };
      if (id) args.id = id;
      const r = await callDeviceTool({ device: faceDevice(), tool: 'robot_face_enroll', args });
      if (r.ok) {
        faces.result = '✓ 登记返回：' + (r.result == null ? '(无返回)' : r.result);
        ElMessage.success('已登记 ' + name);
        faces.enrollName = '';
        faces.enrollId = '';
        await refresh();
      } else {
        faces.result = '✕ ' + (r.error || '登记失败');
        ElMessage.error(r.error || '登记失败');
      }
    } catch (e) {
      faces.result = '✕ ' + errOf(e);
      ElMessage.error(errOf(e));
    } finally {
      faces.enrolling = false;
    }
  }

  /** Guided capture used by the wizard (new member or extra sample for an existing one). */
  async function capture({ name, targetId }) {
    const args = { name, guided: true };
    if (targetId) args.id = targetId;
    const r = await callDeviceTool({ device: faceDevice(), tool: 'robot_face_enroll', args });
    const d = payload(r.result);
    if (r.ok && d && d.enrolled) {
      await refresh();
      return { ok: true, name: d.name, id: d.id, samples: d.samples };
    }
    return { ok: false, message: (d && (d.error || d.reason)) || r.error || '采集失败（未检到脸？请正对镜头重试）' };
  }

  /** Manual pan/tilt while lining up the camera in wizard step 1. */
  async function alignCamera(action) {
    if (!requireBody('调整云台')) return;
    const label = { up: '仰起', down: '低头', left: '左转', right: '右转', center: '回正' }[action] || action;
    try {
      const r = await callDeviceTool({ device: faceDevice(), tool: 'robot_face_align', args: { action } });
      const d = payload(r.result);
      if (r.ok && (!d || d.ok !== false)) {
        ElMessage.success('云台已' + label + (d && d.s3 != null ? `（俯仰 ${d.s3} / 水平 ${d.s6}）` : ''));
      } else {
        ElMessage.error((d && d.error) || r.error || '云台调整失败');
      }
    } catch (e) {
      ElMessage.error(errOf(e));
    }
  }

  async function login() {
    if (!requireBody('登录')) return;
    faces.logging = true;
    try {
      const r = await callDeviceTool({ device: faceDevice(), tool: 'robot_face_login', args: {} });
      const d = payload(r.result);
      if (r.ok && d && d.logged_in) {
        ElMessage.success(`登录成功：${d.name}（${d.id}）`);
        await refresh();
      } else if (r.ok && d && d.logged_in === false) {
        ElMessage.warning('登录失败：未认出已登记的脸' + (d.detail?.reason ? `（${d.detail.reason}）` : ''));
      } else {
        ElMessage.error((d && d.error) || r.error || '登录失败');
      }
    } catch (e) {
      ElMessage.error(errOf(e));
    } finally {
      faces.logging = false;
    }
  }

  async function logout() {
    try {
      const r = await callDeviceTool({ device: faceDevice(), tool: 'robot_face_logout', args: {} });
      if (r.ok) {
        ElMessage.success('已退出登录');
        await refresh();
      } else {
        ElMessage.error(r.error || '退出失败');
      }
    } catch (e) {
      ElMessage.error(errOf(e));
    }
  }

  async function saveLoginEnabled() {
    faces.switching = true;
    const want = faces.loginEnabled;
    try {
      const r = await setFaceLogin(want);
      if (r.ok) {
        faces.loginEnabled = !!r.face_login_enabled;
        ElMessage.success(r.face_login_enabled ? '人脸登录已开启' : '人脸登录已关闭（默认）');
        if (!r.face_login_enabled && faces.currentLogin) await logout();
      } else {
        faces.loginEnabled = !want;
        ElMessage.error(r.error || '切换失败');
      }
    } catch (e) {
      faces.loginEnabled = !want;
      ElMessage.error(errOf(e));
    } finally {
      faces.switching = false;
    }
  }

  async function saveEdit({ key, oldName, oldId, name, id }) {
    const newName = String(name || '').trim();
    const newId = String(id || '').trim();
    if (!newName) {
      ElMessage.error('称呼不能为空');
      return false;
    }
    if (newId && newId !== oldId && !validId(newId)) return false;
    const body = { key };
    if (newName !== oldName) body.name = newName;
    if (newId && newId !== oldId) body.id = newId;
    if (!body.name && !body.id) {
      ElMessage.info('没有改动');
      return true;
    }
    try {
      const r = await renameFace(body);
      if (r.ok) {
        ElMessage.success('已更新：' + r.id + ' / ' + r.name);
        await refresh();
        return true;
      }
      ElMessage.error(r.error || '编辑失败');
      return false;
    } catch (e) {
      ElMessage.error(errOf(e));
      return false;
    }
  }

  async function remove(row) {
    if (
      !(await confirmAction(
        `确认从人脸库删除「${row.name}」（${row.id}）？其全部样本将丢失。`,
        '删除确认',
      ))
    ) {
      return;
    }
    try {
      const r = await deleteFaceApi(row.id);
      if (r.ok && r.deleted) {
        ElMessage.success('已删除 ' + row.name);
        await refresh();
      } else {
        ElMessage.error(r.error || (r.deleted === false ? '库中无此人' : '删除失败'));
      }
    } catch (e) {
      ElMessage.error(errOf(e));
    }
  }

  async function saveThreshold() {
    faces.saving = true;
    try {
      const r = await setFaceThreshold(faces.threshold);
      if (r.ok) {
        if (typeof r.threshold === 'number') faces.threshold = r.threshold;
        ElMessage.success('阈值已保存（下次识别生效）');
      } else {
        ElMessage.error(r.error || '保存失败');
      }
    } catch (e) {
      ElMessage.error(errOf(e));
    } finally {
      faces.saving = false;
    }
  }

  /** Suggested nickname for a new member: 新人N, skipping taken names. */
  function defaultName() {
    const taken = new Set(faces.persons.map((p) => String(p.name || '').toLowerCase()));
    let k = faces.persons.length + 1;
    while (taken.has(`新人${k}`.toLowerCase())) k += 1;
    return `新人${k}`;
  }

  return {
    faces,
    mpBodyReady,
    faceDevice,
    requireBody,
    refresh,
    enroll,
    capture,
    alignCamera,
    login,
    logout,
    saveLoginEnabled,
    saveEdit,
    remove,
    saveThreshold,
    defaultName,
  };
}
