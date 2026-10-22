/** Known (persisted) + live (WebSocket) device lists with search filters and paging. */
import { computed, reactive, ref } from 'vue';
import { deleteDevice, listKnownDevices, listLiveDevices } from '@/api/device';
import { confirmAction, useApi } from './useApi';

const LIVE_HIDDEN_COLS = ['features', 'audio_params'];

export function useKnownDevices() {
  const known = reactive({ total: 0, items: [] });
  const page = ref(1);
  const keyword = ref('');
  const selection = ref([]);
  const { loading, run } = useApi();

  const filtered = computed(() => {
    const q = keyword.value.toLowerCase().trim();
    if (!q) return known.items;
    return known.items.filter((d) =>
      [d.device_id, d.model, d.ip, d.firmware_version].some((v) => String(v || '').toLowerCase().includes(q)),
    );
  });

  async function load() {
    const r = await run(() => listKnownDevices(page.value));
    if (r) {
      known.total = r.total || 0;
      known.items = r.items || [];
    }
    return r;
  }

  async function remove(row) {
    if (!row || !row.device_id) {
      ElMessage.warning('该行没有设备ID');
      return false;
    }
    const extra = Number(row.merged) > 1 ? `（同 MAC 共 ${row.merged} 条记录一并删除）` : '';
    if (!(await confirmAction(`确认删除设备 ${row.device_id}${extra}？删除后需设备重新接入才会再次出现。`, '删除设备'))) {
      return false;
    }
    const r = await run(() => deleteDevice(row.device_id));
    if (r && r.ok) {
      ElMessage.success(`已删除 ${r.deleted} 条登记`);
      await load();
      return true;
    }
    if (r) ElMessage.error(r.error || '删除失败');
    return false;
  }

  return { known, filtered, page, keyword, selection, loading, load, remove, onPageChange: load };
}

export function useLiveDevices() {
  const rows = ref([]);
  const keyword = ref('');
  const { loading, run } = useApi();

  const columns = computed(() =>
    rows.value[0] ? Object.keys(rows.value[0]).filter((k) => !LIVE_HIDDEN_COLS.includes(k)) : [],
  );

  const filtered = computed(() => {
    const q = keyword.value.toLowerCase().trim();
    if (!q) return rows.value;
    return rows.value.filter((d) =>
      [d.clientId, d.deviceId, d.mac, d.ip, d.type, d.status, d.name, d.version].some((v) =>
        String(v || '').toLowerCase().includes(q),
      ),
    );
  });

  async function load() {
    const r = await run(() => listLiveDevices());
    rows.value = Array.isArray(r) ? r : [];
  }

  return { rows, filtered, columns, keyword, loading, load };
}
