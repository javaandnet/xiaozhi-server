/** HomeKit home devices: settings, LAN scan / pairing, direct control and renaming. */
import { reactive } from 'vue';
import {
  controlHomeKit,
  getHomeKitSettings,
  getHomeKitStates,
  getHomeKitStatus,
  pairHomeKit,
  renameHomeKit,
  saveHomeKitSettings,
  scanHomeKit,
} from '@/api/home';
import { fmtTs } from './useFormat';

function errOf(e) {
  return String(e?.message || e);
}

export function useHomeKit() {
  const hk = reactive({
    loading: false,
    saving: false,
    scanning: false,
    pairing: false,
    status: { enabled: false, lights: [], paired: [], lastStartAt: null },
    settings: { enabled: false, deviceName: '', discoveryTimeoutMs: 15000 },
    devices: [],
    ui: {},
  });

  /** Slider/switch model of a light, created on first use. */
  function uiOf(light) {
    if (!hk.ui[light.key]) {
      hk.ui[light.key] = reactive({ power: false, brightness: 50, colorTemp: 50 });
    }
    return hk.ui[light.key];
  }

  async function load() {
    hk.loading = true;
    try {
      const [st, se] = await Promise.all([getHomeKitStatus(), getHomeKitSettings()]);
      if (st && st.ok) {
        hk.status = st;
        for (const l of st.lights || []) uiOf(l);
      }
      if (se && se.ok) hk.settings = { ...hk.settings, ...se.settings };
    } catch (e) {
      ElMessage.error('家庭设备状态读取失败：' + errOf(e));
    } finally {
      hk.loading = false;
    }
    // 回填真实开关/亮度/暖度（无响应则跳过，不阻断整页）
    syncStates();
  }

  /** 拉取各灯实时状态并回填到本地开关/滑块模型（best-effort，静默失败）。 */
  async function syncStates() {
    try {
      const r = await getHomeKitStates();
      if (!r.ok) return;
      for (const l of hk.status.lights || []) {
        const s = r.states?.[l.key];
        if (!s || s.error) continue;
        const ui = uiOf(l);
        if (s.power != null) ui.power = s.power;
        if (s.brightnessPct != null) ui.brightness = s.brightnessPct;
        if (s.colorTempPct != null) ui.colorTemp = s.colorTempPct;
      }
    } catch (e) {
      /* advisory only: keep local defaults on failure */
    }
  }

  async function saveSettings() {
    hk.saving = true;
    try {
      const r = await saveHomeKitSettings(hk.settings);
      if (r.ok) {
        ElMessage.success('已保存' + (r.persisted ? '（写入 config.json）' : '（仅本次运行生效）'));
        await load();
      } else {
        ElMessage.error(r.error || '保存失败');
      }
    } catch (e) {
      ElMessage.error(errOf(e));
    } finally {
      hk.saving = false;
    }
  }

  async function scan() {
    hk.scanning = true;
    try {
      const r = await scanHomeKit();
      if (r.ok) {
        hk.devices = r.devices || [];
        ElMessage.success(`发现 ${hk.devices.length} 台 HomeKit 设备`);
      } else {
        ElMessage.error(r.error || '扫描失败');
      }
    } catch (e) {
      ElMessage.error(errOf(e));
    } finally {
      hk.scanning = false;
    }
  }

  async function pair(row) {
    // 配对码只在配对时需要，改为点“配对”时弹框输入（弹窗本身即确认，不再二次 confirm）
    let pin;
    try {
      const r = await ElMessageBox.prompt(
        `输入 ${row.name || row.id} 的 HomeKit 配对码（8 位数字，如 13056827 或 997-71-230）`,
        '🔗 HomeKit 配对',
        {
          inputPlaceholder: '例如 13056827',
          inputValidator: (v) =>
            String(v || '').replace(/\D/g, '').length === 8 ? true : '配对码需为 8 位数字',
          confirmButtonText: '配对',
          cancelButtonText: '取消',
        },
      );
      pin = String(r.value || '').trim();
    } catch {
      return;
    }
    hk.pairing = true;
    try {
      const r = await pairHomeKit(pin, row.name);
      if (r.ok) {
        ElMessage.success('配对成功，工具池已刷新');
        await Promise.all([load(), scan()]);
      } else {
        ElMessage.error(r.error || '配对失败');
      }
    } catch (e) {
      ElMessage.error(errOf(e));
    } finally {
      hk.pairing = false;
    }
  }

  async function control(light, args) {
    try {
      const r = await controlHomeKit(light.key, args);
      if (!r.ok) {
        ElMessage.error(r.error || '控制失败');
        await load();
      }
    } catch (e) {
      ElMessage.error(errOf(e));
      await load();
    }
  }

  async function rename(light) {
    let name;
    try {
      const r = await ElMessageBox.prompt('输入新名称（语音呼叫与页面显示都用它）', `重命名 · ${light.name}`, {
        inputValue: light.name,
        inputPattern: /^\S.{0,19}$/,
        inputErrorMessage: '1-20 个字符，不能含空白开头',
        confirmButtonText: '保存',
        cancelButtonText: '取消',
      });
      name = String(r.value || '').trim();
    } catch {
      return;
    }
    try {
      const res = await renameHomeKit(light.key, name);
      if (res.ok) {
        ElMessage.success(`已改名为「${name}」` + (res.persisted ? '' : '（仅本次运行生效）'));
        await load();
      } else {
        ElMessage.error(res.error || '改名失败');
      }
    } catch (e) {
      ElMessage.error(errOf(e));
    }
  }

  return { hk, uiOf, load, saveSettings, scan, pair, control, rename, fmtTs };
}
