/**
 * MasterPi connection config (primary / backup server) — module-level singleton so
 * the page and the face helpers read the same device identity.
 */
import { reactive } from 'vue';
import { getMasterPiConfig, getMasterPiStatus, setMasterPiConfig } from '@/api/masterpi';

const mp = reactive({
  loading: false,
  saving: false,
  host: '',
  user: '',
  primary: '',
  backup: '',
  deviceName: '',
  deviceId: '',
  status: { active: '', enabled: '' },
  pageUrl: '',
  error: '',
});

let loaded = false;

export function useMasterPi() {
  async function load() {
    mp.loading = true;
    mp.error = '';
    try {
      const r = await getMasterPiConfig();
      if (r.ok) {
        mp.host = r.target.host;
        mp.user = r.target.user;
        mp.pageUrl = r.target.configPageUrl || '';
        mp.primary = r.primary || '';
        mp.backup = r.backup || '';
        mp.deviceName = r.deviceName || '';
        mp.deviceId = r.deviceId || '';
        mp.status = (await getMasterPiStatus()) || {};
        loaded = true;
      } else {
        mp.error = r.error || '读取失败';
      }
    } catch (e) {
      mp.error = String(e?.message || e);
    } finally {
      mp.loading = false;
    }
  }

  async function save() {
    mp.saving = true;
    mp.error = '';
    try {
      const r = await setMasterPiConfig({
        primary: mp.primary,
        backup: mp.backup,
        deviceName: mp.deviceName,
        restart: true,
      });
      if (r.ok) ElMessage.success(r.restarted ? '已保存并重启客户端服务' : '已保存（未重启）');
      else mp.error = r.restartError || r.error || '保存失败';
      if (r.status) mp.status = r.status;
    } catch (e) {
      mp.error = String(e?.message || e);
    } finally {
      mp.saving = false;
    }
  }

  function firstLoad() {
    if (!loaded) return load();
    return Promise.resolve();
  }

  return { mp, load, save, firstLoad };
}
