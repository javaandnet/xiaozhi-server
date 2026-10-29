<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { disconnect, wake } from '@/api/voice';
import { useRobotStatus } from '@/composables/useRobotStatus';
import { useRefreshBus } from '@/composables/useRefreshBus';
import { useKnownDevices, useLiveDevices } from '@/composables/useDevices';
import { getHealth } from '@/api/device';
import { confirmAction, useApi } from '@/composables/useApi';
import KnownDevicesTable from '@/components/devices/KnownDevicesTable.vue';
import LiveDevicesTable from '@/components/devices/LiveDevicesTable.vue';
import GlobalAudioDialog from '@/components/devices/GlobalAudioDialog.vue';
import PracticeDialog from '@/components/devices/PracticeDialog.vue';
import DeviceProfileDialog from '@/components/devices/DeviceProfileDialog.vue';
import BroadcastDialog from '@/components/devices/BroadcastDialog.vue';
import DeviceCommandDialog from '@/components/devices/DeviceCommandDialog.vue';
import ConversationsDialog from '@/components/devices/ConversationsDialog.vue';
import DeviceDetailDialog from '@/components/devices/DeviceDetailDialog.vue';

const tab = ref('known');
const {
  known,
  filtered: filteredKnown,
  page: knownPage,
  keyword: filterKnown,
  selection: knownSel,
  loading: knownLoading,
  load: loadKnown,
  remove: removeDevice,
} = useKnownDevices();
const {
  rows: liveRows,
  filtered: filteredLive,
  columns: liveCols,
  keyword: filterLive,
  loading: liveLoading,
  load: loadLive,
} = useLiveDevices();
const { state: robotStatus, robotReadyNames, load: loadRobotStatus } = useRobotStatus();
const { register, unregister } = useRefreshBus();
const { loading: bulkWaking, run } = useApi();

// 家云互联链路状态（hub 侧显示家里分支在线/离线；branch 侧显示本机）
const peer = ref(null);
async function loadPeer() {
  try {
    const h = await getHealth();
    peer.value = h?.peer || null;
  } catch { peer.value = null; }
}

const audioRef = ref(null);
const practiceRef = ref(null);
const profileRef = ref(null);
const broadcastRef = ref(null);
const commandRef = ref(null);
const convsRef = ref(null);
const detailRef = ref(null);

async function reload() {
  await Promise.all([loadKnown(), loadLive(), loadPeer()]);
}

async function bulkWake() {
  const ids = knownSel.value.map((r) => r.device_id).filter(Boolean);
  const r = await run(async () => {
    if (ids.length === 0) return wake({});
    let n = 0;
    for (const id of ids) {
      const one = await wake({ deviceId: id });
      if (one.success) n += one.devices || 0;
    }
    return { success: n > 0, devices: n };
  });
  if (!r) return;
  if (r.success) ElMessage.success(`已唤醒 ${r.devices} 台设备（退出休息模式）`);
  else if (ids.length) ElMessage.warning('所选设备均不在线，未能唤醒');
  else ElMessage.error(r.error || '唤醒失败');
}

async function wakeOne(row) {
  const r = await run(() => wake({ deviceId: row.deviceId || row.clientId }));
  if (!r) return;
  if (r.success) ElMessage.success(`已唤醒 ${r.devices} 台设备（退出休息模式）`);
  else ElMessage.error(r.error || '唤醒失败');
}

async function disconnectOne(row) {
  const label = row.deviceId || row.mac || row.clientId;
  if (!(await confirmAction(`确定断开设备 ${label} 的 WebSocket 连接？设备端会自动重连。`, '断开确认'))) return;
  const r = await run(() => disconnect(row.clientId));
  if (!r) return;
  if (r.success) {
    ElMessage.success('已断开');
    await Promise.all([loadLive(), loadKnown()]);
  } else {
    ElMessage.error(r.error || '断开失败');
  }
}

function broadcastToSelection() {
  broadcastRef.value.open(knownSel.value.map((r) => r.device_id).filter(Boolean));
}

function broadcastToRow(row) {
  const id = row.deviceId || row.mac || row.device_id || row.id || '';
  broadcastRef.value.open(id ? [id] : []);
}

onMounted(() => {
  register(reload);
  reload();
  // 在线状态随设备在家/云实例间漂移，静态快照很快失真：本页驻留期间定时重拉 live 列表
  liveTimer = setInterval(loadLive, 20000);
});

let liveTimer = null;
onBeforeUnmount(() => {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  unregister();
});
</script>

<template>
  <el-tabs v-model="tab">
    <el-tab-pane label="注册设备（持久化）" name="known">
      <div class="row">
        <el-button class="op-btn" size="small" :loading="knownLoading" @click="reload">⟳ 刷新</el-button>
        <el-tag v-if="peer && peer.role === 'hub'" size="small" :type="peer.branch_online ? 'success' : 'danger'">
          互联：家里{{ peer.branch_online ? '在线' : '离线' }}
        </el-tag>
        <el-input
          v-model="filterKnown"
          size="small"
          style="width: 220px"
          placeholder="🔍 搜索 MAC/型号/IP"
          clearable
        />
        <el-button size="small" type="warning" plain @click="audioRef.open()">⚙ 语音与语言（全局）</el-button>
        <el-button size="small" type="success" plain @click="practiceRef.open()">🎙 口语练习模式</el-button>
        <span class="hint">
          共 {{ known.total }} 台，当前显示 {{ filteredKnown.length }} 台，已选 {{ knownSel.length }} 台
        </span>
        <el-tag
          size="small"
          effect="plain"
          :type="robotStatus.robotReadyProviders > 0 ? 'success' : 'info'"
          style="margin-left: 10px"
        >
          🔧 机器人硬件：{{
            robotStatus.robotReadyProviders > 0
              ? '在线 · ' + robotReadyNames + ' · ' + robotStatus.robotTotalTools + ' 工具'
              : '离线（无工具提供方）'
          }}
        </el-tag>
        <el-button size="small" text :loading="robotStatus.loading" @click="loadRobotStatus">刷新</el-button>
      </div>
      <div class="row" style="margin-top: 6px">
        <el-button size="small" type="primary" @click="broadcastToSelection">
          📢 语音广播{{ knownSel.length ? '（已选' + knownSel.length + '台）' : '（未选=全部在线）' }}
        </el-button>
        <el-button size="small" type="warning" plain :loading="bulkWaking" @click="bulkWake">
          🔔 唤醒{{ knownSel.length ? '（已选' + knownSel.length + '台）' : '（未选=全部在线）' }}
        </el-button>
        <span class="hint">勾选左侧复选框选择目标设备；广播不选则对所有在线设备，休息中设备也能收到；唤醒=退出休息模式。</span>
      </div>

      <KnownDevicesTable
        :rows="filteredKnown"
        @select="(r) => (knownSel = r)"
        @speak="broadcastToRow"
        @command="(p) => commandRef.open(p)"
        @settings="(id) => profileRef.open(id)"
        @convs="(id) => convsRef.open(id)"
        @remove="removeDevice"
      />
      <el-pagination
        v-model:current-page="knownPage"
        style="margin-top: 10px"
        layout="prev, pager, next"
        :total="known.total"
        :page-size="50"
        @current-change="loadKnown"
      />
    </el-tab-pane>

    <el-tab-pane :label="'当前在线（WS）' + (liveRows.length ? ' · ' + liveRows.length : '')" name="live">
      <div class="row">
        <el-button class="op-btn" size="small" :loading="liveLoading" @click="reload">⟳ 刷新</el-button>
        <el-input
          v-model="filterLive"
          size="small"
          style="width: 220px"
          placeholder="🔍 搜索 设备ID/IP/型号"
          clearable
        />
        <span class="hint">本次启动后建立 WebSocket 连接的设备</span>
      </div>

      <LiveDevicesTable
        :rows="filteredLive"
        :columns="liveCols"
        @speak="broadcastToRow"
        @command="(p) => commandRef.open(p)"
        @wake="wakeOne"
        @settings="(id) => profileRef.open(id)"
        @convs="(id) => convsRef.open(id)"
        @detail="(row) => detailRef.open(row)"
        @disconnect="disconnectOne"
      />
    </el-tab-pane>
  </el-tabs>

  <GlobalAudioDialog ref="audioRef" />
  <PracticeDialog ref="practiceRef" />
  <DeviceProfileDialog ref="profileRef" />
  <BroadcastDialog ref="broadcastRef" />
  <DeviceCommandDialog ref="commandRef" />
  <ConversationsDialog ref="convsRef" />
  <DeviceDetailDialog ref="detailRef" />
</template>
