/**
 * Device & settings management routes.
 * Extracted verbatim from index.js setupRoutes; behavior unchanged.
 */
import path from 'path';
import fs from 'fs';
import { channelLogger } from '../../utils/logger.js';
import { getActionCatalog, actionIds } from '../services/robotActions.js';
import { initializeWebSocketHandler } from '../handlers/websocket.js';

export function registerDeviceRoutes(app, ctx) {
  const configPath = ctx.configPath;

  // ===== per-device 语音/语言设定（设备个体覆盖，未设字段跟随全局；存 devices.settings）=====
  // 机器人动作类型目录（供设定页勾选装载）：id 为 sanitize 后的工具名，与注入 LLM 的 function.name 一致。
  app.get('/api/robot/action-types', (_req, res) => {
    res.json({ ok: true, items: getActionCatalog() });
  });

  // 跨实例 face_found 接收端（改动三）：身体注册在云端时，hub 将感知事件经 peer 通道
  // 转发到实际持有语音设备的家侧，由此本地解析 settings.robot.body 并放送。
  app.post('/api/robot/face-found', async (req, res) => {
    const { bodyKey, person, personId } = req.body || {};
    if (!bodyKey) return res.status(400).json({ ok: false, error: 'bodyKey 必填' });
    const handler = ctx.webSocketHandler;
    if (!handler || typeof handler._dispatchFaceFound !== 'function') {
      return res.status(500).json({ ok: false, error: 'WebSocket handler 未初始化' });
    }
    try {
      const r = await handler._dispatchFaceFound(bodyKey, person, personId);
      res.json({ ok: true, ...(r || {}) });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  app.get('/api/settings/device', (req, res) => {
    const deviceId = String(req.query.deviceId || '');
    if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId 必填' });
    const settings = ctx.store ? (ctx.store.getDeviceSettings(deviceId) || {}) : {};
    res.json({
      ok: true,
      deviceId,
      settings,
      effective: { language: settings.language || ctx.config?.language?.default || 'zh' }
    });
  });
  app.post('/api/settings/device', (req, res) => {
    const deviceId = String(req.body?.deviceId || '');
    if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId 必填' });
    const lang = req.body?.language;
    if (lang !== undefined && lang !== null && lang !== '' && !['zh', 'ja', 'en'].includes(lang)) {
      return res.status(400).json({ ok: false, error: 'language 须为 zh/ja/en（null/空=跟随全局）' });
    }
    const audio = req.body?.audio;
    if (audio !== undefined && audio !== null && typeof audio !== 'object') {
      return res.status(400).json({ ok: false, error: 'audio 须为对象' });
    }
    if (!ctx.store) return res.status(500).json({ ok: false, error: '设备库不可用' });
    // 字段级合并：language=null 清除个体设定；audio 各字段单独覆盖/清除（未提交=保持原值，null/空串=清除该项）
    const prev = ctx.store.getDeviceSettings(deviceId) || {};
    const next = { ...prev };
    if (lang === undefined) { /* 保持原值 */ }
    else if (lang === null || lang === '') delete next.language;
    else next.language = lang;
    if (audio === null) {
      delete next.audio;
    } else if (audio !== undefined) {
      const merged = { ...(prev.audio || {}) };
      for (const k of ['minMaxAmplitude', 'minAvgAmplitude', 'silenceThresholdMs', 'absoluteSpeechFloor', 'speechToNoiseMin', 'minActiveWindows', 'windowMs']) {
        const v = audio[k];
        if (v === undefined) { /* 保持原值 */ }
        else if (v === null || v === '') delete merged[k];
        else if (Number.isFinite(Number(v))) merged[k] = Number(v);
        else return res.status(400).json({ ok: false, error: `audio.${k} 须为数字` });
      }
      if (Object.keys(merged).length > 0) next.audio = merged; else delete next.audio;
    }
    // robot：后台将设备设为“机器人”时，才对其实会话注入身体人设 + 挂载设备工具（function calling）
    const robot = req.body?.robot;
    if (robot === null) {
      delete next.robot;
    } else if (robot !== undefined) {
      if (typeof robot !== 'object') return res.status(400).json({ ok: false, error: 'robot 须为对象' });
      const rmerged = { ...(prev.robot || {}) };
      if (robot.enabled === true || robot.enabled === false) rmerged.enabled = robot.enabled;
      if (robot.maxFunctions === undefined) { /* 保持原值 */ }
      else if (robot.maxFunctions === null || robot.maxFunctions === '') delete rmerged.maxFunctions;
      else if (Number.isFinite(Number(robot.maxFunctions)) && Number(robot.maxFunctions) >= 0) rmerged.maxFunctions = Number(robot.maxFunctions);
      else return res.status(400).json({ ok: false, error: 'robot.maxFunctions 须为 >=0 的数字' });
      // robot.body：绑定该小智指挥的具体机器人硬件（工具提供方的稳定标识 device_id/mac）；null/空=解绑（回退全局）
      if (robot.body === undefined) { /* 保持原值 */ }
      else if (robot.body === null || robot.body === '') delete rmerged.body;
      else if (typeof robot.body === 'string') rmerged.body = robot.body.trim();
      else return res.status(400).json({ ok: false, error: 'robot.body 须为字符串' });
      // robot.actions：选择装载到 LLM 的动作类型（sanitize 后的工具名数组）；
      // undefined=保持原值；null=不装载（回退“全部注入”旧行为）；数组=只注入该子集（空数组=不注入）。
      if (robot.actions === undefined) { /* 保持原值 */ }
      else if (robot.actions === null) { delete rmerged.actions; }
      else if (Array.isArray(robot.actions)) {
        const valid = actionIds();
        if (robot.actions.some((a) => !valid.includes(String(a)))) {
          return res.status(400).json({ ok: false, error: `robot.actions 含未知动作id，合法：${valid.join(',')}` });
        }
        rmerged.actions = [...new Set(robot.actions.map(String))];
      } else return res.status(400).json({ ok: false, error: 'robot.actions 须为数组' });
      if (Object.keys(rmerged).length > 0) next.robot = rmerged; else delete next.robot;
    }
    // home：家居控制白名单（settings.home.enabled=true 的小智会话才注入 HomeKit 灯具工具）
    const home = req.body?.home;
    if (home === null) {
      delete next.home;
    } else if (home !== undefined) {
      if (typeof home !== 'object') return res.status(400).json({ ok: false, error: 'home 须为对象' });
      const hmerged = { ...(prev.home || {}) };
      if (home.enabled === true || home.enabled === false) hmerged.enabled = home.enabled;
      if (Object.keys(hmerged).length > 0) next.home = hmerged; else delete next.home;
    }
    // persona：设备人设（名字/性格），注入 LLM 系统提示词；null/空字段=清除个体设定（回退默认“小智”）
    const persona = req.body?.persona;
    if (persona === null) {
      delete next.persona;
    } else if (persona !== undefined) {
      if (typeof persona !== 'object') return res.status(400).json({ ok: false, error: 'persona 须为对象' });
      const pmerged = { ...(prev.persona || {}) };
      for (const k of ['name', 'personality']) {
        const v = persona[k];
        if (v === undefined) { /* 保持原值 */ }
        else if (v === null || v === '') delete pmerged[k];
        else if (typeof v === 'string' && v.trim()) pmerged[k] = v.trim().slice(0, k === 'name' ? 30 : 200);
        else return res.status(400).json({ ok: false, error: `persona.${k} 须为字符串` });
      }
      if (Object.keys(pmerged).length > 0) next.persona = pmerged; else delete next.persona;
    }
    const saved = ctx.store.setDeviceSettings(deviceId, next);
    if (!saved) return res.status(404).json({ ok: false, error: `设备未登记: ${deviceId}` });
    // 热更在线连接（屏幕文案/模式标签即时重推，阈值下次音频判定即生效）
    if (ctx.webSocketHandler) {
      try { ctx.webSocketHandler.applyDeviceSettings(deviceId, next); } catch (e) { console.warn(`device settings push failed: ${e.message}`); }
    }
    res.json({ ok: true, deviceId, settings: next });
  });

  // 默认语言（全局托底）：语音无法判定语种时，LLM 回复/欢迎语/TTS 音色跟随该值。
  // 保存即热生效并回写 config.json；设备个体设定优先于本值。
  app.get('/api/settings/language', (_req, res) => {
    res.json({ ok: true, default: ctx.config?.language?.default || 'zh' });
  });
  app.post('/api/settings/language', (req, res) => {
    const lang = String(req.body?.default || '');
    if (!['zh', 'ja', 'en'].includes(lang)) {
      return res.status(400).json({ ok: false, error: 'default 须为 zh/ja/en 之一' });
    }
    ctx.config.language = { ...(ctx.config.language || {}), default: lang };
    if (ctx.llmService) ctx.llmService.defaultLanguage = lang;
    if (ctx.ttsService) ctx.ttsService.defaultLanguage = lang;
    // 热推屏幕文案包/模式标签到所有在线设备（固件 SetStatus 入口查表替换）
    if (ctx.webSocketHandler) {
      try { ctx.webSocketHandler.applyLanguageToSessions(lang); } catch (e) { console.warn(`i18n push failed: ${e.message}`); }
    }
    let persisted = false;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      fs.writeFileSync(configPath + '.bak', JSON.stringify(raw, null, 2)); // 备份原文件
      raw.language = { ...(raw.language || {}), default: lang };
      fs.writeFileSync(configPath + '.tmp', JSON.stringify(raw, null, 2));
      fs.renameSync(configPath + '.tmp', configPath);
      persisted = true;
    } catch (e) {
      channelLogger.warn(`config.json language persist failed: ${e.message}`);
    }
    console.log(`[xiaozhi] default language set to ${lang} (persisted=${persisted})`);
    res.json({ ok: true, default: lang, persisted });
  });

  // 音频有效性(VAD振幅)阈值配置：读取 + 热更新 + 持久化 config.json
  app.get('/api/settings/audio', (req, res) => {
    const audio = ctx.config?.audio || {};
    const vad = ctx.config?.vad || {};
    res.json({
      ok: true,
      thresholds: {
        minMaxAmplitude: audio.minMaxAmplitude ?? 500,
        minAvgAmplitude: audio.minAvgAmplitude ?? 50,
        silenceThresholdMs: vad.silenceThresholdMs ?? 1500
      }
    });
  });

  app.post('/api/settings/audio', (req, res) => {
    const max = Number.parseInt(req.body?.minMaxAmplitude, 10);
    const avg = Number.parseInt(req.body?.minAvgAmplitude, 10);
    const silence = Number.parseInt(req.body?.silenceThresholdMs, 10);
    if (!Number.isInteger(max) || !Number.isInteger(avg) || max < 0 || max > 10000 || avg < 0 || avg > 10000) {
      return res.status(400).json({ ok: false, error: '振幅阈值须为 0~10000 的整数' });
    }
    if (!Number.isInteger(silence) || silence < 300 || silence > 5000) {
      return res.status(400).json({ ok: false, error: '静默阈值须为 300~5000ms 的整数' });
    }
    // 热更新运行时处理器默认阈值（对未设置设备专属阈值的会话立即可效）
    const handler = initializeWebSocketHandler();
    handler.updateAudioThresholds({ minMaxAmplitude: max, minAvgAmplitude: avg, silenceThresholdMs: silence });
    ctx.config.audio = { ...(ctx.config.audio || {}), minMaxAmplitude: max, minAvgAmplitude: avg };
    ctx.config.vad = { ...(ctx.config.vad || {}), silenceThresholdMs: silence };
    // 持久化 config.json
    let persisted = false;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      raw.audio = { ...(raw.audio || {}), minMaxAmplitude: max, minAvgAmplitude: avg };
      raw.vad = { ...(raw.vad || {}), silenceThresholdMs: silence };
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
      persisted = true;
    } catch (e) {
      channelLogger.warn(`config.json 持久化失败: ${e.message}`);
    }
    res.json({
      ok: true,
      thresholds: { ...handler.defaultAudioThresholds, silenceThresholdMs: ctx.config.vad.silenceThresholdMs },
      persisted
    });
  });

  // 模式切换触发词（前台自由定义）：config.json → modeKeywords。
  // 识别文本去标点后与短语全等即命中；保存即热生效（匹配处实时读 config）。
  const MODE_KW_KEYS = ['employeeOn', 'employeeOff', 'restOn', 'restOff', 'practiceOn', 'practiceOff', 'practiceEndManual', 'practiceEndAuto', 'intercomOn', 'intercomOff', 'intercomCall'];
  app.get('/api/settings/mode-keywords', (_req, res) => {
    const kw = ctx.config?.modeKeywords || {};
    res.json({ ok: true, modeKeywords: Object.fromEntries(MODE_KW_KEYS.map((k) => [k, Array.isArray(kw[k]) ? kw[k] : []])) });
  });

  app.post('/api/settings/mode-keywords', (req, res) => {
    const input = req.body?.modeKeywords || {};
    const clean = {};
    for (const k of MODE_KW_KEYS) {
      const list = Array.isArray(input[k]) ? input[k] : [];
      clean[k] = [...new Set(list.map((p) => String(p).trim()).filter(Boolean))];
      if (clean[k].length > 20) return res.status(400).json({ ok: false, error: `每组最多 20 个短语（${k}）` });
      if (clean[k].some((p) => p.length > 30)) return res.status(400).json({ ok: false, error: `单个短语最长 30 字（${k}）` });
    }
    // 安全闸门：休息模式必须保留至少一个退出词，否则设备将无法被语音唤醒回聊天
    if (!clean.restOff.length) return res.status(400).json({ ok: false, error: '必须至少保留一个“退出休息”短语' });
    ctx.config.modeKeywords = clean;
    let persisted = false;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      raw.modeKeywords = clean;
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
      persisted = true;
    } catch (e) {
      channelLogger.warn(`config.json 持久化失败: ${e.message}`);
    }
    res.json({ ok: true, modeKeywords: clean, persisted });
  });

  // 对讲机模式（双设备原声透传，PTT 半双工）：服务器侧远程开/关指定设备的对讲模式。
  // POST { deviceId, on: true|false, peer? }：peer 可为人设名/deviceId/clientId（进入时解析）；
  // 不带 peer 则用该机 settings.intercom.peer。开关均热生效不落 config。
  app.post('/api/settings/intercom', async (req, res) => {
    const b = req.body || {};
    if (typeof b.on !== 'boolean') return res.status(400).json({ ok: false, error: 'on 须为 true/false' });
    if (!ctx.webSocketHandler || !ctx.webSocketHandler.intercomService) {
      return res.status(500).json({ ok: false, error: 'WebSocket 处理器未就绪' });
    }
    if (b.on && ctx.config.intercom && ctx.config.intercom.enabled === false) {
      return res.status(400).json({ ok: false, error: '对讲功能已被 config.intercom.enabled=false 关闭' });
    }
    try {
      const r = await ctx.webSocketHandler.applyIntercomMode(b.deviceId || null, b.on, b.peer ? String(b.peer) : null);
      if (b.on && r.applied === 0) {
        return res.status(400).json({ ok: false, error: r.error || '未找到在线设备或对讲对端解析失败', ...r });
      }
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 口语练习模式配置：读取 + 热更新 + 持久化 config.json → practice
  // POST 可选 deviceId 即时开/关在线会话；不带 deviceId 只改全局默认（仅影响新连接）
  app.get('/api/settings/practice', (_req, res) => {
    const p = ctx.config.practice || {};
    res.json({
      ok: true,
      practice: {
        enabled: !!p.enabled,
        endMode: p.endMode === 'auto' ? 'auto' : 'manual',
        summaryPrompt: p.summaryPrompt || '',
        classifierPrompt: p.classifierPrompt || '',
        silenceTimeoutMs: p.silenceTimeoutMs ?? 120000
      }
    });
  });

  app.post('/api/settings/practice', (req, res) => {
    const b = req.body || {};
    const cur = { ...(ctx.config.practice || {}) };
    const next = { ...cur };
    if (b.enabled !== undefined) next.enabled = !!b.enabled;
    if (b.endMode !== undefined) {
      if (b.endMode !== null && !['manual', 'auto'].includes(b.endMode)) {
        return res.status(400).json({ ok: false, error: 'endMode 须为 manual/auto' });
      }
      if (b.endMode === null || b.endMode === '') delete next.endMode;
      else next.endMode = b.endMode;
    }
    if (b.summaryPrompt !== undefined) {
      if (b.summaryPrompt === null || b.summaryPrompt === '') delete next.summaryPrompt;
      else if (typeof b.summaryPrompt === 'string') next.summaryPrompt = b.summaryPrompt;
      else return res.status(400).json({ ok: false, error: 'summaryPrompt 须为字符串' });
    }
    if (b.classifierPrompt !== undefined) {
      if (b.classifierPrompt === null || b.classifierPrompt === '') delete next.classifierPrompt;
      else if (typeof b.classifierPrompt === 'string') next.classifierPrompt = b.classifierPrompt;
      else return res.status(400).json({ ok: false, error: 'classifierPrompt 须为字符串' });
    }
    if (b.silenceTimeoutMs !== undefined) {
      const ms = Number(b.silenceTimeoutMs);
      if (!Number.isInteger(ms) || ms < 10000 || ms > 600000) {
        return res.status(400).json({ ok: false, error: 'silenceTimeoutMs 须为 10000~600000 的整数' });
      }
      next.silenceTimeoutMs = ms;
    }
    ctx.config.practice = next;
    // 在线连接即时切换（仅当显式携带 sessions 开关时）
    let applied = 0;
    if (b.enabled !== undefined && ctx.webSocketHandler) {
      try { applied = ctx.webSocketHandler.applyPracticeMode(b.deviceId || null, next.enabled, next.endMode || 'manual'); }
      catch (e) { channelLogger.warn(`practice sessions push failed: ${e.message}`); }
    }
    let persisted = false;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      raw.practice = next;
      fs.writeFileSync(configPath + '.tmp', JSON.stringify(raw, null, 2));
      fs.renameSync(configPath + '.tmp', configPath);
      persisted = true;
    } catch (e) {
      channelLogger.warn(`config.json practice persist failed: ${e.message}`);
    }
    console.log(`[xiaozhi] practice settings updated (applied=${applied}, persisted=${persisted})`);
    res.json({ ok: true, practice: next, applied, persisted });
  });

  // 备用服务器地址 server1（xiaozhi-server 可改）：设备主地址(server0)连不上时自动切此备用。
  // server0 沿用原逻辑（自动探测本机IP / config.server.websocket 覆盖），本接口只维护 server1。
  app.get('/api/settings/server-fallback', (_req, res) => {
    const srv = ctx.config?.server || {};
    res.json({ ok: true, server0: srv.websocket || '', server1: srv.websocket_fallback || '' });
  });

  app.post('/api/settings/server-fallback', (req, res) => {
    const value = String(req.body?.server1 ?? '').trim();
    if (value && !/^wss?:\/\//i.test(value)) {
      return res.status(400).json({ ok: false, error: 'server1 必须是以 ws:// 或 wss:// 开头的完整地址' });
    }
    ctx.config.server = ctx.config.server || {};
    ctx.config.server.websocket_fallback = value;
    // OTAHandler 拿的是启动时的 server 快照，这里同步刷新以便热生效
    if (ctx.otaHandler && ctx.otaHandler.config) {
      ctx.otaHandler.config.server = ctx.otaHandler.config.server || {};
      ctx.otaHandler.config.server.websocket_fallback = value;
    }
    let persisted = false;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      raw.server = raw.server || {};
      raw.server.websocket_fallback = value;
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
      persisted = true;
    } catch (e) {
      channelLogger.warn(`config.json 持久化失败: ${e.message}`);
    }
    res.json({ ok: true, server1: value, persisted });
  });

  // 断开指定在线设备的 WebSocket 连接（管理操作，自旧 manage 页合并并真实实现）
  app.post('/api/disconnect', (req, res) => {
    const clientId = String(req.body?.clientId || '').trim();
    if (!clientId) {
      return res.status(400).json({ success: false, error: '缺少 clientId' });
    }
    const handler = ctx.webSocketHandler || initializeWebSocketHandler();
    const closed = handler.closeDevice(clientId);
    res.json({ success: closed, ...(closed ? {} : { error: '设备不在线或未找到' }) });
  });

  // 设备管理API（当前在线设备，Map 需转数组才能正确序列化）
  app.get('/api/devices', (req, res) => {
    if (ctx.deviceManager) {
      res.json(ctx.deviceManager.getAllDevices().map(d => d.toJSON()));
    } else {
      res.status(500).json({ error: 'Device manager not initialized' });
    }
  });

  // 对端实例实时在线清单（家云合并视图）：hub 经 dispatch，branch 直连 hub。
  // 韧性：拉取成功（含空数组=对端真实无在线）才刷新缓存并记为「最近成功值」；
  // 拉取失败（重启/网络抖动）不退化成空口径，而是沿用最近成功值（60s 宽限期），
  // 避免本机 branch 无本地语音连接时，把已开机、实际连在云端的设备误显示为离线。
  const PEER_LIVE_TTL = 10000; // 正常缓存
  const PEER_LIVE_RETRY = 3000; // 命中失败兜底后短缓存，尽快重试
  const PEER_LIVE_GRACE = 60000; // 失败时可沿用最近成功值的上限
  async function peerLiveIds() {
    const link = ctx.peerLink;
    if (!link || (!link.isHub && !link.isBranch)) return [];
    const cache = ctx._peerLiveCache;
    if (cache && Date.now() - cache.at < (cache.stale ? PEER_LIVE_RETRY : PEER_LIVE_TTL)) return cache.ids;
    let ids = null; // null = 本次拉取失败（与「成功但为空」严格区分）
    try {
      const r = link.isHub
        ? (link.branchOnline() ? await link.dispatch('GET', '/api/devices', null, 8000) : { error: 'branch offline' })
        : await link.callHub('GET', '/api/devices', null, 8000);
      const list = r && !r.error ? r.body : null;
      if (Array.isArray(list)) ids = list.map((d) => String(d.deviceId || '').toLowerCase()).filter(Boolean);
    } catch (e) {
      console.warn(`[xiaozhi] peer live devices fetch failed: ${e.message}`);
    }
    if (Array.isArray(ids)) {
      ctx._peerLiveCache = { at: Date.now(), ids, stale: false };
      ctx._peerLiveLastGood = { at: Date.now(), ids };
      return ids;
    }
    // 拉取失败：宽限期内沿用最近一次成功值，超期才退化为空
    const good = ctx._peerLiveLastGood;
    const serveIds = good && (Date.now() - good.at < PEER_LIVE_GRACE) ? good.ids : [];
    ctx._peerLiveCache = { at: Date.now(), ids: serveIds, stale: true };
    return serveIds;
  }

  // 已知设备列表（含离线，来自持久化设备注册表）
  app.get('/api/devices/known', async (req, res) => {
    const store = ctx.ensureStore();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const result = store.listDevices({ limit, offset });
    // 在线以实时 WS 连接为准：DB online 列可能因进程强杀/掉线未走 close 复位而残留为 1。
    // 取口与放送/唤醒完全一致（handler.getBroadcastTargets：readyState 判活），
    // handler 不可用时退回设备管理器在线视图（两者同为连接口径）。
    const handler = ctx.webSocketHandler || initializeWebSocketHandler();
    const liveDevices = (handler && typeof handler.getBroadcastTargets === 'function'
      ? handler.getBroadcastTargets(null)
      : (ctx.deviceManager && typeof ctx.deviceManager.getOnlineDevices === 'function'
        ? ctx.deviceManager.getOnlineDevices() : [])) || [];
    const liveIds = new Set(
      liveDevices.map((d) => String(d.deviceId).toLowerCase())
    );
    // 合并对端实例在线：设备在家/云间漂移时两边走私看到的都是全局真值
    for (const id of await peerLiveIds()) liveIds.add(id);
    for (const it of result.items || []) {
      const keys = [String(it.mac || '').toLowerCase(), ...(it.device_ids || []).map((x) => String(x).toLowerCase())];
      it.online = keys.some((k) => k && liveIds.has(k)) ? 1 : 0;
      // 休息为展示态（设备回待机、WS 仍在线）：只要持久标记为休息即展示"休息"（区别于在线聊天/真离线）
      it.rest = Number(it.resting) === 1 ? 1 : 0;
      // 机器人型小智标志（settings.robot.enabled）：供列表展示“机器人硬件”列
      let robotOn = false; let robotBody = null; let homeOn = false;
      try {
        const s = it.settings ? JSON.parse(it.settings) : null;
        const rb = s && s.robot; robotOn = !!(rb && rb.enabled === true); robotBody = rb && rb.body ? String(rb.body) : null;
        const hm = s && s.home; homeOn = !!(hm && hm.enabled === true);
      } catch (e) { /* 忽略 */ }
      it.robot = robotOn ? 1 : 0;
      it.robot_body = robotBody;
      it.home = homeOn ? 1 : 0;
    }
    res.json(result);
  });

  // 删除设备：按 mac 归一删除同一物理设备的全部登记行（设备一览中的重复/残留条目）
  app.post('/api/devices/delete', (req, res) => {
    const store = ctx.ensureStore();
    const deviceId = String(req.body?.deviceId || '');
    if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId 必填' });
    try {
      const deleted = store.deleteDevice(deviceId);
      res.json({ ok: true, deviceId, deleted });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 设备/对话统计
  app.get('/api/devices/stats', (req, res) => {
    const store = ctx.ensureStore();
    res.json({
      live: ctx.deviceManager ? ctx.deviceManager.getStats() : null,
      registered: store.getStats()
    });
  });

  // 对话记录查询（支持 deviceId / role / limit / offset 过滤）
  app.get('/api/conversations', (req, res) => {
    const store = ctx.ensureStore();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { deviceId, role } = req.query;
    res.json(store.listConversations({
      deviceId: deviceId || null,
      role: (role === 'user' || role === 'bot') ? role : null,
      limit,
      offset
    }));
  });

  // 会话管理API
  app.get('/api/sessions', (req, res) => {
    if (ctx.sessionManager) {
      res.json(ctx.sessionManager.sessions || {});
    } else {
      res.status(500).json({ error: 'Session manager not initialized' });
    }
  });

  // WebSocket URL 信息 API - 提供 WS 和 WSS 两种协议
  app.get('/api/websocket/urls', (req, res) => {
    const useHttps = process.env.USE_HTTPS === 'true' || false;
    const protocol = useHttps ? 'wss' : 'ws';

    res.json({
      message: 'WebSocket连接信息',
      urls: {
        ws: `ws://${ctx.host}:${ctx.port}/xiaozhi/v1/`,
        wss: `wss://${ctx.host}:${ctx.port}/xiaozhi/v1/`
      },
      current: `${protocol}://${ctx.host}:${ctx.port}/xiaozhi/v1/`,
      use_https: useHttps,
      port: ctx.port,
      host: ctx.host
    });
  });

  // 文本 → LLM 分析（仅注入该身体工具）→ 定向执行该身体工具 → 同步返回回复。
  // speak=true 时，把回复文本经该身体绑定的小智语音设备播报（TTS 走小智，不推给身体 client）。
  app.post('/api/device/command', async (req, res) => {
    try {
      const device = String(req.body?.device || '');
      const text = String(req.body?.text || '').trim();
      const speak = req.body?.speak !== false && req.body?.speak !== 'false';
      const kind = String(req.body?.kind || 'voice');
      if (!device || !text) return res.json({ ok: false, error: 'device 与 text 必填' });
      if (!ctx.webSocketHandler || typeof ctx.webSocketHandler.runHardwareCommand !== 'function') {
        return res.json({ ok: false, error: 'WebSocket handler 未就绪' });
      }
      const r = await ctx.webSocketHandler.runHardwareCommand(device, text, { speak, kind });
      res.json({ ok: true, device, text, reply: r.reply, toolCount: r.toolCount, spoken: r.spoken || null, routed: r.routed || null });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });
}
