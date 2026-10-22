/**
 * Robot hardware (device-MCP provider) status — module-level singleton so the
 * device table, the device settings dialog and the MasterPi page share one copy.
 */
import { computed, reactive, ref } from 'vue';
import { getMcpStatus } from '@/api/mcp';

const state = reactive({
  loading: false,
  readyProviders: 0,
  totalTools: 0,
  robotReadyProviders: 0,
  robotTotalTools: 0,
  providers: [],
});
const loaded = ref(false);

/** Stable key of a provider: device_id -> mac -> clientId. */
export function providerKeyOf(p) {
  return p.deviceId || p.mac || p.clientId;
}

export function useRobotStatus() {
  // 只取「机器人身体」（device_type=robot/peripheral/mcp_only），小智自带工具不列入
  const robotBodies = computed(() => state.providers.filter((p) => p.robot));
  const robotReadyNames = computed(() => robotBodies.value.filter((p) => p.ready).map((p) => p.name).join('、'));
  const bodyOptions = computed(() =>
    robotBodies.value.map((p) => ({
      value: providerKeyOf(p),
      label: `${p.name}${p.ready ? '' : '（离线）'} · ${providerKeyOf(p)}`,
    })),
  );

  async function load() {
    state.loading = true;
    try {
      const r = await getMcpStatus();
      if (r && r.ok) {
        Object.assign(state, {
          readyProviders: r.readyProviders || 0,
          totalTools: r.totalTools || 0,
          robotReadyProviders: r.robotReadyProviders || 0,
          robotTotalTools: r.robotTotalTools || 0,
          providers: r.providers || [],
        });
        loaded.value = true;
      }
    } catch (e) {
      // Provider status is cosmetic on the device list: keep the last snapshot.
      console.warn('[useRobotStatus] load failed:', e.message);
    } finally {
      state.loading = false;
    }
  }

  // 某行（机器人型小智）绑定身体的在线状态
  function hwStatusFor(row) {
    if (!Number(row.robot)) return null;
    if (!row.robot_body) return { type: 'info', text: '未绑定' };
    const k = String(row.robot_body).toLowerCase();
    const p = state.providers.find((x) => [x.deviceId, x.mac, x.clientId].some((v) => v && String(v).toLowerCase() === k));
    if (p && p.ready) return { type: 'success', text: '在线·' + p.name };
    return { type: 'danger', text: '绑定身体离线' };
  }

  function firstLoad() {
    if (!loaded.value) load();
  }

  return { state, robotBodies, robotReadyNames, bodyOptions, load, firstLoad, hwStatusFor };
}
