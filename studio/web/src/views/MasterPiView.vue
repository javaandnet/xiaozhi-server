<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRobotStatus, providerKeyOf } from '@/composables/useRobotStatus';
import { useKnownDevices } from '@/composables/useDevices';
import { useFaceStream } from '@/composables/useFaceStream';
import { useFaces } from '@/composables/useFaces';
import { useMasterPi } from '@/composables/useMasterPi';
import { useRefreshBus } from '@/composables/useRefreshBus';
import { fmtTs } from '@/composables/useFormat';
import DeviceCommandDialog from '@/components/devices/DeviceCommandDialog.vue';
import FaceWizardDialog from '@/components/masterpi/FaceWizardDialog.vue';
import FaceEditDialog from '@/components/masterpi/FaceEditDialog.vue';

const { state: robotStatus, robotBodies, load: loadRobotStatus } = useRobotStatus();
const { known, load: loadKnown } = useKnownDevices();
const { mpStream, refresh: refreshStream, start: startStream, stop: stopStream } = useFaceStream();
const {
  faces,
  mpBodyReady,
  refresh: refreshFaces,
  enroll,
  login: loginFace,
  logout: logoutFace,
  saveLoginEnabled,
  saveThreshold,
  remove: removeFace,
} = useFaces();
const { mp, load: loadMasterPi, save: saveMasterPi } = useMasterPi();
const { register, unregister } = useRefreshBus();

const commandRef = ref(null);
const wizardRef = ref(null);
const editRef = ref(null);

// 反查某身体绑定的小智语音设备（注册设备表里的 robot_body 字段）
function boundVoicesFor(key) {
  const k = String(key || '').toLowerCase();
  return known.items
    .filter((it) => it.robot_body && String(it.robot_body).toLowerCase() === k)
    .map((it) => it.device_name || it.device_id || it.mac || '');
}

function openWizard(mode, row) {
  wizardRef.value.open(mode === 'append' ? { mode, targetId: row.id, name: row.name } : { mode });
}

async function reload() {
  await Promise.all([loadRobotStatus(), loadKnown(), refreshStream(), refreshFaces(), loadMasterPi()]);
}

onMounted(() => {
  register(reload);
  reload();
});

onBeforeUnmount(unregister);
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header>
      <div style="display: flex; align-items: center; gap: 10px">
        <b>🦾 机器人身体列表（device-MCP 工具提供方）</b>
        <el-button size="small" text :loading="robotStatus.loading" style="margin-left: auto" @click="loadRobotStatus">
          ⟳ 刷新
        </el-button>
      </div>
    </template>
    <div class="hint" style="margin-bottom: 8px">
      统一管理在线的机器人身体：直调其工具（含 <span class="mono">robot_search_face</span>）或发自然语言指令；播报经其绑定的小智语音设备。身体不在设备一览内，统一在此页管理。
    </div>
    <el-table :data="robotBodies" size="small" style="width: 100%">
      <el-table-column label="名称" min-width="120">
        <template #default="s"><b>{{ s.row.name }}</b></template>
      </el-table-column>
      <el-table-column label="标识" min-width="200">
        <template #default="s"><span class="mono">{{ providerKeyOf(s.row) }}</span></template>
      </el-table-column>
      <el-table-column label="版本" width="90">
        <template #default="s"><span class="mono">{{ s.row.version || '-' }}</span></template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="s">
          <el-tag :type="s.row.ready ? 'success' : 'info'" size="small">{{ s.row.ready ? '在线' : '离线' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="工具数" width="80">
        <template #default="s">{{ s.row.toolCount }}</template>
      </el-table-column>
      <el-table-column label="绑定的小智" min-width="200">
        <template #default="s">
          <span v-if="boundVoicesFor(providerKeyOf(s.row)).length" class="mono">
            {{ boundVoicesFor(providerKeyOf(s.row)).join('、') }}
          </span>
          <span v-else class="hint">未绑定</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="140" fixed="right">
        <template #default="s">
          <el-button
            size="small"
            type="success"
            plain
            :disabled="!s.row.ready"
            @click="commandRef.open({ device: providerKeyOf(s.row), label: '身体 · ' + s.row.name, kind: 'body' })"
          >
            🛠 下指令
          </el-button>
        </template>
      </el-table-column>
      <template #empty><span class="hint">暂无机器人身体（离线或未连接）</span></template>
    </el-table>
  </el-card>

  <el-card class="card" shadow="never">
    <template #header>
      <div style="display: flex; align-items: center; gap: 10px">
        <b>📹 摄像头实时画面（人脸检测调试）</b>
        <el-tag size="small" :type="mpStream.running ? 'success' : 'info'" effect="plain">
          {{ mpStream.running ? '运行中' : '未运行' }}
        </el-tag>
      </div>
    </template>
    <div class="hint" style="margin-bottom: 10px">
      按需启动派上 <span class="mono">vision_stream.py</span> 的 MJPEG 预览：绿框=检出人脸，红框+黄点=目标(最大)脸，白十字=画面中心，<span class="mono">ex/ey</span>
      为归一化偏差（tol=±0.14 判居中）。检测器已升级为 <b>DNN(YuNet)</b>（印刷/卡通脸不再误检）。预览运行时相机由本进程独占，<span class="mono">search_face</span>
      会自动<b>借用本预览的检测框</b>（走 <span class="mono">/frames</span> 端点），两者可同时进行；预览未启动时 search_face 回退自行开相机。
    </div>
    <div class="row" style="margin-bottom: 12px">
      <el-button size="small" type="primary" :loading="mpStream.loading" :disabled="mpStream.running" @click="startStream">
        ▶ 启动预览
      </el-button>
      <el-button size="small" :loading="mpStream.loading" :disabled="!mpStream.running" @click="stopStream">
        ■ 停止
      </el-button>
      <el-button size="small" text @click="refreshStream">⟳ 刷新状态</el-button>
      <a v-if="mpStream.url" :href="mpStream.url" target="_blank" class="hint">独立窗口打开 {{ mpStream.url }} ↗</a>
    </div>
    <div v-if="mpStream.running" style="text-align: center">
      <img
        :src="mpStream.imgSrc"
        style="max-width: 100%; border: 1px solid var(--el-border-color); border-radius: 6px"
        alt="stream"
      />
    </div>
    <div v-else class="hint">（预览未启动 — 点击上方“启动预览”，画面出现在此处）</div>
  </el-card>

  <el-card class="card" shadow="never">
    <template #header>
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
        <b>👤 人脸库（识别 / 登记 / 登录）</b>
        <span class="hint">
          当前登录：
          <b v-if="faces.currentLogin">{{ faces.currentLogin.name }}（{{ faces.currentLogin.id }}）</b>
          <span v-else>未登录</span>
        </span>
        <el-tag v-if="!faces.loginEnabled" size="small" type="info" effect="plain">登录功能已关闭</el-tag>
        <el-button size="small" text :loading="faces.loading" style="margin-left: auto" @click="refreshFaces">
          ⟳ 刷新
        </el-button>
      </div>
    </template>
    <div class="hint" style="margin-bottom: 10px">
      检测 <span class="mono">YuNet</span> + 识别 <span class="mono">SFace</span>：登记后 <span class="mono">search_face</span>
      对准人脸会识出 <span class="mono">person</span>，face_found 播报带称呼。成员以自动生成的 <span class="mono">ID</span>
      存储（可改，与称呼均全局查重），展示/播报用称呼；每人最多存 5 个样本；余弦距离阈值越小越严。登记需被登记者正面/够近/保持不动，预览开着时自动借帧可同时操作。
    </div>
    <div class="row" style="margin-bottom: 12px">
      <el-input
        v-model="faces.enrollName"
        placeholder="登记称呼（如 fengleiren）"
        size="small"
        style="width: 180px"
        @keyup.enter="enroll"
      />
      <el-input
        v-model="faces.enrollId"
        placeholder="ID（可选，留空自动生成）"
        size="small"
        style="width: 190px"
        @keyup.enter="enroll"
      />
      <el-button size="small" type="primary" :loading="faces.enrolling" :disabled="!faces.enrollName.trim()" @click="enroll">
        🙋 登记（直连身体）
      </el-button>
      <el-button size="small" type="warning" @click="openWizard('new')">📷 引导登记向导</el-button>
      <el-button
        size="small"
        type="success"
        plain
        :loading="faces.logging"
        :disabled="!faces.loginEnabled || !mpBodyReady"
        @click="loginFace"
      >
        🔑 人脸登录
      </el-button>
      <el-button size="small" plain :disabled="!faces.currentLogin" @click="logoutFace">🚪 退出登录</el-button>
      <span class="hint">登录功能</span>
      <el-switch v-model="faces.loginEnabled" size="small" :loading="faces.switching" @change="saveLoginEnabled" />
      <span class="hint">判定阈值</span>
      <el-input-number
        v-model="faces.threshold"
        size="small"
        :min="0.1"
        :max="0.8"
        :step="0.01"
        :precision="3"
        controls-position="right"
        style="width: 120px"
      />
      <el-button size="small" :loading="faces.saving" @click="saveThreshold">💾 设定</el-button>
    </div>
    <el-table :data="faces.persons" size="small" style="width: 100%">
      <el-table-column label="ID" width="110">
        <template #default="s"><span class="mono">{{ s.row.id }}</span></template>
      </el-table-column>
      <el-table-column label="称呼" min-width="120">
        <template #default="s"><b>{{ s.row.name }}</b></template>
      </el-table-column>
      <el-table-column label="样本数" width="80">
        <template #default="s">{{ s.row.samples }}</template>
      </el-table-column>
      <el-table-column label="登记时间" width="170">
        <template #default="s"><span class="mono">{{ fmtTs(s.row.created_at) }}</span></template>
      </el-table-column>
      <el-table-column label="最近更新" width="170">
        <template #default="s"><span class="mono">{{ fmtTs(s.row.updated_at) }}</span></template>
      </el-table-column>
      <el-table-column label="操作" width="240" fixed="right">
        <template #default="s">
          <el-button size="small" type="success" plain @click="openWizard('append', s.row)">➕ 追加样本</el-button>
          <el-button size="small" plain @click="editRef.open(s.row)">✏️ 编辑</el-button>
          <el-button size="small" type="danger" plain @click="removeFace(s.row)">删除</el-button>
        </template>
      </el-table-column>
      <template #empty><span class="hint">人脸库为空 — 先点“登记”录入第一个人</span></template>
    </el-table>
    <div v-if="faces.result" class="hint" style="margin-top: 8px">{{ faces.result }}</div>
  </el-card>

  <el-card class="card" shadow="never">
    <template #header><b>🤖 MasterPi 连接服务器（主 / 备）</b></template>
    <div class="hint" style="margin-bottom: 10px">
      直写派（<span class="mono">{{ mp.user }}@{{ mp.host }}</span>）本地
      <span class="mono">~/masterpi_client/config.json</span> 的 server 块；保存后自动重启 systemd 客户端。客户端断线会重连并依次尝试主→备，<b>切到备后不自动回主</b>（直到进程重启）。
    </div>
    <div class="row" style="margin-bottom: 12px">
      <el-button size="small" :loading="mp.loading" @click="loadMasterPi">⟳ 从设备读取</el-button>
      <el-button size="small" type="primary" :loading="mp.saving" @click="saveMasterPi">💾 保存并重启</el-button>
      <el-tag size="small" :type="mp.status.active === 'active' ? 'success' : 'info'" effect="plain">
        服务 {{ mp.status.active || '?' }}
      </el-tag>
      <el-tag size="small" :type="mp.status.enabled === 'enabled' ? 'success' : 'warning'" effect="plain">
        开机 {{ mp.status.enabled || '?' }}
      </el-tag>
      <a v-if="mp.pageUrl" :href="mp.pageUrl" target="_blank" class="hint">设备本地设置页 {{ mp.pageUrl }} ↗</a>
    </div>
    <el-form label-width="120px" style="max-width: 640px" @submit.prevent>
      <el-form-item label="主服务器">
        <el-input v-model="mp.primary" placeholder="ws://192.168.1.55:8003/xiaozhi/v1/" />
      </el-form-item>
      <el-form-item label="备服务器">
        <el-input v-model="mp.backup" placeholder="留空=不启用备份；如 ws://192.168.1.60:8003/xiaozhi/v1/" />
      </el-form-item>
      <el-form-item label="设备名称">
        <el-input v-model="mp.deviceName" placeholder="MasterPi" style="max-width: 280px" />
        <span class="hint mono" style="margin-left: 8px">deviceId: {{ mp.deviceId || '-' }}</span>
      </el-form-item>
    </el-form>
    <div v-if="mp.error" class="hint" style="color: var(--el-color-danger)">⚠ {{ mp.error }}</div>
  </el-card>

  <DeviceCommandDialog ref="commandRef" />
  <FaceWizardDialog ref="wizardRef" />
  <FaceEditDialog ref="editRef" />
</template>
