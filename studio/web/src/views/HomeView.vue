<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useHomeKit } from '@/composables/useHomeKit';
import { useRefreshBus } from '@/composables/useRefreshBus';
import { fmtTs } from '@/composables/useFormat';

const { hk, uiOf, load, saveSettings, scan, pair, control, rename } = useHomeKit();
const { register, unregister } = useRefreshBus();

const unpairHelpVisible = ref(false);

onMounted(() => {
  register(load);
  load();
  // 进入页面先自动扫描一遍，直接展示局域网内设备与状态
  scan();
});

onBeforeUnmount(unregister);
</script>

<template>
  <el-card class="card" shadow="never">
    <template #header>
      <div style="display: flex; align-items: center; gap: 10px">
        <b>🏠 HomeKit 家庭设备</b>
        <el-button size="small" text :loading="hk.loading" style="margin-left: auto" @click="load">⟳ 刷新</el-button>
      </div>
    </template>
    <div class="row">
      <el-tag size="small" :type="hk.status.enabled ? 'success' : 'info'" effect="plain">
        功能 {{ hk.status.enabled ? '已启用' : '已停用' }}
      </el-tag>
      <el-tag size="small" :type="(hk.status.lights || []).length ? 'success' : 'warning'" effect="plain">
        在线灯具 {{ (hk.status.lights || []).length }} · 已配对 {{ (hk.status.paired || []).length }}
      </el-tag>
      <span class="hint">最近启动发现：{{ hk.status.lastStartAt ? fmtTs(hk.status.lastStartAt) : '-' }}</span>
    </div>
    <el-form inline>
      <el-form-item label="启用">
        <el-switch v-model="hk.settings.enabled" />
      </el-form-item>
      <el-form-item label="设备名过滤">
        <el-input v-model="hk.settings.deviceName" placeholder="留空=局域网内全部（如 iHaper）" style="width: 220px" />
      </el-form-item>
      <el-form-item label="发现窗口(ms)">
        <el-input-number
          v-model="hk.settings.discoveryTimeoutMs"
          :min="3000"
          :max="60000"
          :step="1000"
          controls-position="right"
          style="width: 130px"
        />
      </el-form-item>
      <el-form-item>
        <el-button size="small" type="primary" :loading="hk.saving" @click="saveSettings">💾 保存</el-button>
      </el-form-item>
    </el-form>
    <div class="hint">停用后不再发现/注入灯具工具；修改发现窗口下次启动/扫描生效。</div>
  </el-card>

  <el-card class="card" shadow="never">
    <template #header><b>📡 局域网扫描 / 配对</b></template>
    <div class="row">
      <el-button type="primary" :loading="hk.scanning" @click="scan">🔍 扫描设备</el-button>
      <span class="hint">目标需处于“可配对”状态（已被其它家庭绑定时请先在家庭 App 移除配件）；进入页面已自动扫描一次，点“配对”时再输入 HomeKit 配对码</span>
    </div>
    <el-table :data="hk.devices" size="small" max-height="300">
      <el-table-column prop="name" label="名称" min-width="160" />
      <el-table-column prop="id" label="配件ID" width="180">
        <template #default="s"><span class="mono">{{ s.row.id }}</span></template>
      </el-table-column>
      <el-table-column label="地址" width="160">
        <template #default="s"><span class="mono">{{ s.row.address }}:{{ s.row.port }}</span></template>
      </el-table-column>
      <el-table-column label="状态" width="160">
        <template #default="s">
          <el-tag v-if="s.row.pairedHere" size="small" type="success">本机已配对</el-tag>
          <el-tag v-else-if="s.row.availableForPairing" size="small" type="warning">可配对</el-tag>
          <el-tag v-else size="small" type="danger">已被其它控制端占用</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="解除配对" width="110">
        <template #default="s">
          <el-button v-if="!s.row.pairedHere && !s.row.availableForPairing" size="small" link type="primary" @click="unpairHelpVisible = true">如何解除？</el-button>
          <span v-else class="hint">-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="s">
          <el-button
            size="small"
            :disabled="s.row.pairedHere || !s.row.availableForPairing"
            :loading="hk.pairing"
            @click="pair(s.row)"
          >
            🔗 配对
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <div v-if="!hk.devices.length" class="hint">暂无扫描结果，点“扫描设备”发现局域网内的 HomeKit 配件。</div>
    <el-dialog v-model="unpairHelpVisible" title="如何解除 HomeKit 配对（让设备回到“可配对”状态）" width="640px">
      <div class="unpair-help">
        <p>“已被其它控制端占用”表示该配件的 mDNS 广播中没有 <b>cf=1</b>（可配对）标志——配件内部仍保存着一个有效的 HomeKit 配对，并非本机（Homecenter）占用的。<b>仅从 iPhone“家庭”App 移除 ≠ 配件复位</b>，配对信息存在配件本体上。</p>
        <p class="unpair-title">① 首选：从所有 Apple 控制端移除（保留 WiFi，灯泡仍在局域网）</p>
        <ul>
          <li>家庭 App → 长按该配件 → 配件设置 → 底部“移除配件”（不是“从房间中移开”）；多数型号移除后即重新广播 cf=1。</li>
          <li>检查同一 iCloud 家庭下的其它 iPhone / iPad / HomePod / Apple TV；曾被米家 / Yeelight 快捷配对的，也在其设置里解除。</li>
          <li>移除后直接回本页重新扫描配对即可，<b>不需要</b>做下面的硬件复位。</li>
        </ul>
        <p class="unpair-title">② 兜底：硬件复位（⚠️ Yeelight 灯泡会连 WiFi 一起清，复位后局域网上扫描不到）</p>
        <ul>
          <li>仅当“移除配件”后仍显示占用时才做。<b>Yeelight 灯泡（YLDP15YL 等）</b>：断电→上电循环 5 次（每次约 2 秒），灯泡闪几下后稳定常亮即复位完成。</li>
          <li>整机复位后必须先用 <b>Yeelight/米家 App 重新配网</b>（手机连 2.4GHz WiFi → 添加设备），灯泡才会回到局域网；配网时若询问是否加入 Apple 家庭，想给 Homecenter 用请跳过。</li>
          <li><b>iHaper 等灯带控制器</b>：长按配对键约 5 秒或电源通断复位（以厂商说明书为准）。</li>
        </ul>
        <p class="unpair-title">③ 回到本页重新配对</p>
        <ul>
          <li>点“🔍 扫描设备”（进入页面已自动扫一次），状态列变为橙色“可配对”后，点该行的“🔗 配对”，在弹窗内输入 HomeKit 配对码（如 13056827）即可。</li>
          <li>若仍显示“已被其它控制端占用”→ HomeKit 未清干净，回步骤②；若<b>完全扫描不到</b>→ 灯泡未连回 WiFi，回步骤②重新配网。</li>
        </ul>
        <p class="hint">详细原理与排查见仓库文档：<span class="mono">doc/使用说明.md</span> 第 9 节</p>
      </div>
      <template #footer>
        <el-button type="primary" @click="unpairHelpVisible = false">知道了</el-button>
      </template>
    </el-dialog>
  </el-card>

  <el-card class="card" shadow="never">
    <template #header><b>💡 设备控制</b></template>
    <div v-for="l in hk.status.lights" :key="l.key" class="light-row">
      <b style="min-width: 120px">{{ l.name }}</b>
      <el-button size="small" text @click="rename(l)">✎ 改名</el-button>
      <span class="mono hint">{{ l.key }}</span>
      <el-switch
        v-model="uiOf(l).power"
        active-text="电源"
        @change="(v) => control(l, { power: v })"
      />
      <template v-if="l.hasBrightness">
        <span class="hint">亮度</span>
        <el-slider v-model="uiOf(l).brightness" :min="0" :max="100" style="width: 180px" @change="(v) => control(l, { brightness: v })" />
      </template>
      <template v-if="l.hasColorTemp">
        <span class="hint">暖度</span>
        <el-slider v-model="uiOf(l).colorTemp" :min="0" :max="100" style="width: 180px" @change="(v) => control(l, { color_temp: v })" />
      </template>
    </div>
    <div v-if="!(hk.status.lights || []).length" class="hint">
      暂无在线灯具：确认设备已上电入网、已配对，或点上方扫描后配对。
    </div>
    <div class="hint" style="margin-top: 8px">
      这些设备同时以小智工具（homekit_light_*）注入语音链路，可直接说“打开台灯/亮度调到50%”。
    </div>
  </el-card>
</template>

<style scoped>
.light-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
</style>

<style>
/* el-dialog teleports to body, scoped styles won't reach it */
.unpair-help p {
  margin: 8px 0;
  line-height: 1.7;
}
.unpair-help .unpair-title {
  font-weight: 600;
  margin-top: 14px;
}
.unpair-help ul {
  margin: 4px 0;
  padding-left: 22px;
  line-height: 1.8;
}
.unpair-help .mono {
  font-family: var(--el-font-family-mono, monospace);
}
.unpair-help .hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
