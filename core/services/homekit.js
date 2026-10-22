import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import BaseService from './base.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// hap-controller is a CommonJS package exposing a HomeKit controller (IP + BLE).
// Only the IP (Wi-Fi) side is used here; BLE native deps are not loaded.
const { IPDiscovery, HttpClient } = require('hap-controller');

// HAP short type codes (0000XXXX-0000-1000-8000-0026BB765291)
const HAP = {
  SERVICE_LIGHTBULB: '43',
  CHAR_ON: '25',
  CHAR_BRIGHTNESS: '8',
  CHAR_COLOR_TEMP: 'ce'
};

/**
 * Normalize a HAP type (full UUID or short hex) into a lowercase, zero-stripped short code.
 */
function normalizeType(t) {
  if (!t) return '';
  let s = String(t).toLowerCase();
  const m = s.match(/^([0-9a-f]{1,8})-0000-1000-8000-0026bb765291$/);
  if (m) s = m[1];
  return s.replace(/^0+/, '');
}

/**
 * HomeKit (方案A) controller service.
 * Discovers Wi-Fi HomeKit accessories on the LAN, pairs with them using the
 * setup pin, persists pairing data, and exposes light control (power / brightness / color temp).
 */
class HomeKitService extends BaseService {
  constructor(config = {}) {
    super('HomeKit', config);
    this.enabled = config.enabled === true;
    this.pin = config.pin || '';
    this.deviceName = config.deviceName || '';
    this.discoveryTimeoutMs = config.discoveryTimeoutMs || 6000;
    // 单次特征读/写超时，避免配件无响应时请求永久挂起（hap-controller HttpClient 无内置超时）
    this.opTimeoutMs = config.opTimeoutMs || 10000;
    // 自定义名称映射："<accessoryId>#s<siid>" -> 显示名（config.homekit.names，语音/管理页共用）
    this.names = config.names && typeof config.names === 'object' ? { ...config.names } : {};
    this.pairingFile = config.pairingFile
      ? path.resolve(__dirname, '../..', config.pairingFile)
      : path.join(__dirname, '../../data/homekit-pairing.json');

    // accessoryId -> HttpClient (persistent)
    this.clients = new Map();
    // lightKey -> { key, name, aid, onIid, brightnessIid, colorTempIid, ranges, client }
    this.lights = new Map();
    this.lastStartAt = null;
  }

  async _initialize() {
    // startup handled explicitly by start()
  }

  async _healthCheck() {
    return {
      message: 'HomeKit服务运行正常',
      enabled: this.enabled,
      lights: this.lights.size,
      paired: Object.keys(this._loadPairingStore()).length
    };
  }

  // ---------------- pairing store ----------------

  _loadPairingStore() {
    try {
      if (fs.existsSync(this.pairingFile)) {
        return JSON.parse(fs.readFileSync(this.pairingFile, 'utf8'));
      }
    } catch (e) {
      console.warn(`[HomeKit] failed to read pairing file: ${e.message}`);
    }
    return {};
  }

  _savePairing(id, data) {
    const store = this._loadPairingStore();
    store[id] = data;
    try {
      fs.mkdirSync(path.dirname(this.pairingFile), { recursive: true });
      fs.writeFileSync(this.pairingFile, JSON.stringify(store, null, 2));
      console.log(`[HomeKit] pairing data saved for ${id}`);
    } catch (e) {
      console.error(`[HomeKit] failed to write pairing file: ${e.message}`);
      throw e;
    }
  }

  // ---------------- lifecycle ----------------

  /**
   * Discover LAN accessories and connect/pair, then build the controllable light set.
   * Never throws on hardware absence: logs and leaves lights empty so boot is not blocked.
   */
  async start() {
    if (!this.enabled) {
      console.log('[HomeKit] disabled, skip startup');
      return;
    }
    this.lastStartAt = Date.now();
    try {
      let found = await this._discover();
      // mDNS 广播有波动，未发到时重试几次，避免启动错过设备
      for (let tries = 0; !found.length && tries < 2; tries++) {
        console.log(`[HomeKit] discovery empty, retry ${tries + 1}`);
        found = await this._discover();
      }
      if (!found.length) {
        console.warn('[HomeKit] no accessories discovered on LAN (lamp offline or not pairing-able)');
        return;
      }
      const store = this._loadPairingStore();
      for (const svc of found) {
        try {
          if (store[svc.id]) {
            await this._connectKnown(svc, store[svc.id]);
          } else if (svc.availableForPairing && this.pin) {
            await this._pairNew(svc);
          } else if (!store[svc.id]) {
            console.log(`[HomeKit] skip ${svc.name || svc.id}: already paired elsewhere or no pin`);
          }
        } catch (e) {
          console.error(`[HomeKit] setup failed for ${svc.name || svc.id}: ${e.message}`);
        }
      }
      console.log(`[HomeKit] startup done, controllable lights: ${this.lights.size}`);
    } catch (e) {
      console.error(`[HomeKit] startup error: ${e.message}`);
    }
  }

  async destroy() {
    for (const client of this.clients.values()) {
      try { client.close && client.close(); } catch (e) { debug(e); }
    }
    this.clients.clear();
    this.lights.clear();
  }

  // ---------------- discovery ----------------

  _discover() {
    return new Promise((resolve) => {
      const discovered = new Map();
      let discovery;
      try {
        discovery = new IPDiscovery();
      } catch (e) {
        console.error(`[HomeKit] IPDiscovery init failed: ${e.message}`);
        return resolve([]);
      }
      discovery.on('serviceUp', (service) => {
        if (!service || !service.id) return;
        // deviceName filter (when configured)
        if (this.deviceName && service.name && !String(service.name).includes(this.deviceName)) return;
        discovered.set(service.id, {
          id: service.id,
          name: service.name,
          address: service.address || (service.addresses && service.addresses[0]),
          port: service.port,
          // hap-controller exposes the unpaired flag as `availableToPair` (sf & 0x01).
          availableForPairing: service.availableToPair
        });
      });
      discovery.start();
      setTimeout(() => {
        try { discovery.stop(); } catch (e) { debug(e); }
        resolve(Array.from(discovered.values()));
      }, this.discoveryTimeoutMs);
    });
  }

  // ---------------- pairing / connect ----------------

  _formatPin(pin) {
    const d = String(pin).replace(/\D/g, '');
    if (d.length !== 8) return pin; // library validates format
    return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5, 8)}`;
  }

  /**
   * Race a client call against a timeout so a stalled accessory can never hang
   * pairing/indexing/control forever (hap-controller has no built-in request timeout).
   */
  _withTimeout(promise, label) {
    const ms = this.opTimeoutMs;
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label || 'HomeKit'} 操作超时(${ms}ms)：设备无响应`)), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  async _pairNew(svc) {
    const client = new HttpClient(svc.id, svc.address, svc.port);
    await client.pairSetup(this._formatPin(this.pin));
    const longTerm = client.getLongTermData();
    this._savePairing(svc.id, longTerm);
    this.clients.set(svc.id, client);
    await this._indexAccessory(svc, client);
    console.log(`[HomeKit] paired new accessory ${svc.name || svc.id}`);
  }

  async _connectKnown(svc, pairingData) {
    const client = new HttpClient(svc.id, svc.address, svc.port, pairingData);
    this.clients.set(svc.id, client);
    await this._indexAccessory(svc, client);
    console.log(`[HomeKit] reconnected known accessory ${svc.name || svc.id}`);
  }

  async _indexAccessory(service, client) {
    const id = service.id; const serviceName = service.name;
    const res = await this._withTimeout(client.getAccessories(), '获取配件描述(accessories)');
    const accessories = res.accessories || res || [];
    let idx = 0;
    for (const acc of accessories) {
      const aid = Number(acc.aid);
      for (const svc of (acc.services || [])) {
        if (normalizeType(svc.type) !== HAP.SERVICE_LIGHTBULB) continue;
        let onIid = null; let brightnessIid = null; let colorTempIid = null; let nameChar = null;
        for (const ch of (svc.characteristics || [])) {
          const t = normalizeType(ch.type);
          const iid = Number(ch.iid);
          if (t === HAP.CHAR_ON) onIid = iid;
          else if (t === HAP.CHAR_BRIGHTNESS) brightnessIid = iid;
          else if (t === HAP.CHAR_COLOR_TEMP) colorTempIid = iid;
          else if (t === '23' && ch.value && typeof ch.value === 'string') nameChar = ch.value;
        }
        if (onIid == null) continue;
        idx += 1;
        const key = `a${aid}_s${svc.iid}`;
        const nameKey = `${String(id).toLowerCase()}#s${svc.iid}`;
        const light = {
          key,
          name: this.names[nameKey] || nameChar || serviceName || `台灯${idx}`,
          nameKey,
          aid,
          onIid,
          brightnessIid,
          colorTempIid,
          ranges: {},
          client,
          accessoryId: id,
          address: service.address,
          port: service.port
        };
        this.lights.set(key, light);
        await this._fetchRanges(light).catch((e) => debug(e));
      }
    }
  }

  /**
   * Rebuild a fresh HAP session for a light's accessory from stored pairing data.
   * Yeelight bulbs often silently drop idle sessions; a stale HttpClient then makes
   * every characteristic request hang until timeout. Returns true on success.
   */
  _rebuildClient(light) {
    const store = this._loadPairingStore();
    const data = store[light.accessoryId];
    if (!data || !light.address || !light.port) return false;
    try {
      const client = new HttpClient(light.accessoryId, light.address, light.port, data);
      this.clients.set(light.accessoryId, client);
      for (const l of this.lights.values()) {
        if (l.accessoryId === light.accessoryId) l.client = client;
      }
      console.log(`[HomeKit] rebuilt session for ${light.name || light.accessoryId}`);
      return true;
    } catch (e) {
      console.warn(`[HomeKit] rebuild session failed for ${light.accessoryId}: ${e.message}`);
      return false;
    }
  }

  async _fetchRanges(light) {
    const refs = [];
    if (light.brightnessIid != null) refs.push(`${light.aid}.${light.brightnessIid}`);
    if (light.colorTempIid != null) refs.push(`${light.aid}.${light.colorTempIid}`);
    if (!refs.length) return;
    const list = await this._withTimeout(light.client.getCharacteristics(refs, { meta: true, type: true }), `读取${light.name}取值范围`);
    const arr = Array.isArray(list) ? list : (list && Array.isArray(list.characteristics) ? list.characteristics : []);
    for (const c of arr) {
      const iid = Number(c.iid);
      const entry = { min: c.minValue, max: c.maxValue };
      if (entry.min == null || entry.max == null) continue;
      if (iid === light.brightnessIid) light.ranges.brightness = entry;
      else if (iid === light.colorTempIid) light.ranges.colorTemp = entry;
    }
  }

  // ---------------- control ----------------

  getLights() {
    return Array.from(this.lights.values());
  }

  lightKeyFromTool(toolName) {
    const prefix = 'homekit_light_';
    return toolName && toolName.startsWith(prefix) ? toolName.slice(prefix.length) : null;
  }

  toolNameForLight(key) {
    return `homekit_light_${key}`;
  }

  _ref(light, iid) {
    return `${light.aid}.${iid}`;
  }

  pctToRange(pct, range) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const min = range && range.min != null ? Number(range.min) : 0;
    const max = range && range.max != null ? Number(range.max) : 100;
    return Math.round(min + (p / 100) * (max - min));
  }

  rangeToPct(val, range) {
    const min = range && range.min != null ? Number(range.min) : 0;
    const max = range && range.max != null ? Number(range.max) : 100;
    if (!Number.isFinite(Number(val)) || max === min) return null;
    return Math.max(0, Math.min(100, Math.round(((Number(val) - min) / (max - min)) * 100)));
  }

  /**
   * 读取灯具当前真实状态（On / Brightness / ColorTemperature）。
   * 返回 { power:bool|null, brightnessPct:int|null, colorTempPct:int|null }。
   */
  async readState(light) {
    const refs = [this._ref(light, light.onIid)];
    if (light.brightnessIid != null) refs.push(this._ref(light, light.brightnessIid));
    if (light.colorTempIid != null) refs.push(this._ref(light, light.colorTempIid));
    const list = await this._withTimeout(light.client.getCharacteristics(refs), `读取${light.name}状态`);
    const arr = Array.isArray(list) ? list : (list && Array.isArray(list.characteristics) ? list.characteristics : []);
    const st = { power: null, brightnessPct: null, colorTempPct: null };
    for (const c of arr) {
      const iid = Number(c.iid);
      if (iid === light.onIid) st.power = !!c.value;
      else if (iid === light.brightnessIid) st.brightnessPct = this.rangeToPct(c.value, light.ranges.brightness);
      else if (iid === light.colorTempIid) st.colorTempPct = this.rangeToPct(c.value, light.ranges.colorTemp);
    }
    return st;
  }

  /**
   * Read live state of all indexed lights in parallel (each timeout-protected).
   * Returns { [lightKey]: {power,brightnessPct,colorTempPct} | {error} } for UI sync.
   */
  async getStates() {
    const out = {};
    await Promise.all([...this.lights.values()].map(async (light) => {
      try {
        out[light.key] = await this.readState(light);
      } catch (e) {
        out[light.key] = { error: e.message };
      }
    }));
    return out;
  }

  /**
   * Apply a control request. args: { power?:bool, brightness?:0-100, color_temp?:0-100 }
   * 控制类指令以设备实际状态为准：下发前先读真实状态（已处于目标态则据实告知），
   * 下发后回读校验，返回基于真实状态的确认文案。
   */
  async applyControl(lightKey, args) {
    if (!this.enabled) throw new Error('HomeKit 功能未启用');
    const light = (lightKey && this.lights.get(lightKey)) || this.getLights()[0];
    if (!light) throw new Error('尚未发现可控制的 HomeKit 灯具');

    const a = typeof args === 'string' ? JSON.parse(args || '{}') : (args || {});
    const wantsPower = typeof a.power === 'boolean';

    // 先读设备真实状态（用户要求：控制指令须先核对实际状态）
    let before = null;
    try { before = await this.readState(light); } catch (e) { before = null; }

    const sets = {};
    if (wantsPower) sets[this._ref(light, light.onIid)] = a.power;
    if (a.brightness != null) sets[this._ref(light, light.brightnessIid)] = this.pctToRange(a.brightness, light.ranges.brightness);
    if (a.color_temp != null) {
      const range = light.ranges.colorTemp || { min: 143, max: 374 };
      sets[this._ref(light, light.colorTempIid)] = this.pctToRange(a.color_temp, range);
    }
    if (!Object.keys(sets).length) {
      return '未指定要调整的开关、亮度或色温';
    }

    // 已处于目标开关状态且无其它调节：据实告知，不重复下发
    if (wantsPower && before && before.power === a.power && a.brightness == null && a.color_temp == null) {
      const extra = before.brightnessPct != null ? `，当前亮度${before.brightnessPct}%` : '';
      return `${light.name}本来就已经是${a.power ? '开着' : '关着'}的${extra}，无需重复操作`;
    }

    // 预读失败往往意味着会话已被灯泡悄悄掉断：先重建会话再写，避免把超时耗在死连接上
    if (!before) this._rebuildClient(light);

    try {
      await this._withTimeout(light.client.setCharacteristics(sets), `${light.name}控制`);
    } catch (e) {
      // 会话可能已失效：重建一次会话并重试（Yeelight 常见）
      if (!this._rebuildClient(light)) throw e;
      await this._withTimeout(light.client.setCharacteristics(sets), `${light.name}控制(重连)`);
    }

    // 回读真实状态做确认（以实际为准，而非凭请求臆断）
    let after = null;
    try { after = await this.readState(light); } catch (e) { after = null; }
    if (!after || after.power == null) {
      return `${light.name}指令已下发，但未能读回设备状态确认`;
    }
    const verb = wantsPower ? (a.power ? '打开' : '关闭') : '调节';
    if (wantsPower && after.power !== a.power) {
      return `${light.name}${verb}指令已下发，但设备实际仍为${after.power ? '开着' : '关着'}，可能未连接或无响应`;
    }
    const extra = after.brightnessPct != null ? `，当前亮度${after.brightnessPct}%` : '';
    return `${light.name}已${verb}${extra}`;
  }

  getStatus() {
    const store = this._loadPairingStore();
    return {
      enabled: this.enabled,
      deviceName: this.deviceName,
      discoveryTimeoutMs: this.discoveryTimeoutMs,
      lastStartAt: this.lastStartAt,
      paired: Object.keys(store),
      lights: this.getLights().map((l) => ({
        key: l.key,
        name: l.name,
        hasBrightness: l.brightnessIid != null,
        hasColorTemp: l.colorTempIid != null
      }))
    };
  }

  /**
   * On-demand pairing (for /api/homekit/pair): discover once and pair a matching accessory.
   */
  async pairNow(pin, deviceName) {
    const prevPin = this.pin;
    if (pin) this.pin = pin;
    try {
      // 不篡改持久过滤字段 this.deviceName（否则会把扫描收窄到该设备、且异常时无法还原）。
      // 改为本地按名字挑选目标；命中不到再退回任意可配对设备。
      const found = await this._discover();
      const pairable = found.filter((s) => s.availableForPairing);
      const target = (deviceName && pairable.find((s) => s.name === deviceName)) || pairable[0];
      if (!target) throw new Error('局域网内未发现可配对的 HomeKit 设备');
      if (!this.pin) throw new Error('缺少配对码(pin)');
      await this._pairNew(target);
      return this.getStatus();
    } finally {
      this.pin = prevPin;
    }
  }

  /**
   * Scan LAN for HomeKit accessories (no pairing), annotate whether each is already paired here.
   */
  async scan() {
    const found = await this._discover();
    const store = this._loadPairingStore();
    return found.map((s) => ({
      name: s.name, id: s.id, address: s.address, port: s.port,
      availableForPairing: !!s.availableForPairing,
      pairedHere: !!store[s.id]
    }));
  }

  /**
   * 重命名灯具：更新内存映射并返回映射对象（由调用方写回 config.json 持久化）。
   */
  renameLight(lightKey, newName) {
    const light = this.lights.get(lightKey);
    if (!light) throw new Error(`灯具 ${lightKey} 不在线或不存在`);
    const name = String(newName || '').trim();
    if (!name) throw new Error('名称不能为空');
    this.names[light.nameKey] = name;
    light.name = name;
    console.log(`[HomeKit] light renamed: ${lightKey} -> ${name}`);
    return this.names;
  }

  /**
   * Hot-update runtime settings (studio 家庭设备页). Persist is handled by the caller.
   */
  saveSettings({ enabled, deviceName, discoveryTimeoutMs }) {
    if (enabled != null) this.enabled = !!enabled;
    if (deviceName != null) this.deviceName = String(deviceName);
    if (discoveryTimeoutMs != null) this.discoveryTimeoutMs = Number(discoveryTimeoutMs) || 15000;
    console.log(`[HomeKit] settings updated: enabled=${this.enabled} deviceName=${this.deviceName || '-'} timeout=${this.discoveryTimeoutMs}ms`);
  }
}

function debug(e) {
  console.debug(`[HomeKit] ${e && e.message ? e.message : e}`);
}

export default HomeKitService;
