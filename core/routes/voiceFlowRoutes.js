/**
 * Voice-flow I/O primitives for external controllers (aistudy / aiinterview).
 * Extracted verbatim from index.js setupRoutes; behavior unchanged.
 *
 * Design: xiaozhi is a thin voice pipe; all intelligence lives in the controller.
 *   Downstream /api/voice/speak: push text to a device for TTS playback.
 *   Upstream /api/voice/session: device enters "answer collect" mode; on roll-up the
 *   aggregated transcript is POSTed back to callbackUrl.
 * Auth: shared secret X-Xiaozhi-Key == config.voiceFlow.token (503 if unset, no bare run).
 */
import { vfAuthorized, vfCallbackAllowed } from './auth.js';

// 板型 model → 友好显示名（设备未自报/未命名时的兑底，避免下拉直接露 MAC）
const BOARD_MODEL_NAMES = {
  'luxiaoban-xiaozhi-1.54tft-wifi': '鹿小班 1.54TFT',
  'xingzhi-cube-1.54tft-wifi': '星智 CUBE 1.54',
  'lichuang-dev': '立创 ESP32S3',
  'surfer-c3-1.14tft': 'Surfer C3 1.14TFT'
};

export function registerVoiceFlowRoutes(app, ctx) {
  // 下行：把文本推给指定设备播报（合成+推流耗时，先验设备再受理后异步发送）
  app.post('/api/voice/speak', (req, res) => {
    const auth = vfAuthorized(ctx.config, req);
    if (!auth.ok) return res.status(auth.code).json({ ok: false, error: auth.error });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text 不能为空' });
    if (!ctx.webSocketHandler) return res.status(500).json({ ok: false, error: 'WebSocket handler 未初始化' });
    const deviceId = req.body?.deviceId || null;
    const targets = ctx.webSocketHandler.getBroadcastTargets(deviceId);
    if (targets.length === 0) return res.status(404).json({ ok: false, error: '设备不在线或未找到' });
    // 先让待机设备就绪再播报（与员工主动播报同链路）；但休息中的设备保持休息：
    // 被动放送不应把睡觉脸踢成下发待机图（keepRest）
    ctx.webSocketHandler.wakeDevices({ deviceId, announce: text, keepRest: true })
      .then((r) => console.log(`[xiaozhi] voice speak(announce, keep rest if resting) queued: ${JSON.stringify(r)}`))
      .catch((e) => console.error('[xiaozhi] voice speak failed:', e.message));
    res.json({ ok: true, accepted: true, devices: targets.length });
  });

  // 上行：注册“作答采集”态；设备说完→整段转写 POST 回 callbackUrl（谁发起会话谁收答案）
  app.post('/api/voice/session', (req, res) => {
    const auth = vfAuthorized(ctx.config, req);
    if (!auth.ok) return res.status(auth.code).json({ ok: false, error: auth.error });
    if (!ctx.webSocketHandler) return res.status(500).json({ ok: false, error: 'WebSocket handler 未初始化' });
    const deviceId = req.body?.deviceId || null;
    const callbackUrl = String(req.body?.callbackUrl || '').trim();
    if (!callbackUrl) return res.status(400).json({ ok: false, error: 'callbackUrl 必填' });
    if (!/^(https?):\/\//i.test(callbackUrl)) return res.status(400).json({ ok: false, error: 'callbackUrl 须为 http(s) 绝对地址' });
    if (!vfCallbackAllowed(ctx.config, callbackUrl)) return res.status(400).json({ ok: false, error: 'callbackUrl 不在 callbackAllowList 内' });
    const endOn = req.body?.endOn === 'auto' ? 'auto' : 'button';
    const applied = ctx.webSocketHandler.startVoiceFlow({
      deviceId,
      endOn,
      callbackUrl,
      sessionId: req.body?.sessionId != null ? String(req.body.sessionId) : null,
      token: req.body?.callbackToken ? String(req.body.callbackToken) : (ctx.config.voiceFlow?.token || '')
    });
    if (applied === 0) return res.status(404).json({ ok: false, error: '设备不在线或未找到' });
    res.json({ ok: true, applied, deviceId: deviceId || 'all', endOn });
  });

  // 结束采集态（清缓冲/停回调，回到普通聊天）
  app.post('/api/voice/session/close', (req, res) => {
    const auth = vfAuthorized(ctx.config, req);
    if (!auth.ok) return res.status(auth.code).json({ ok: false, error: auth.error });
    if (!ctx.webSocketHandler) return res.status(500).json({ ok: false, error: 'WebSocket handler 未初始化' });
    const deviceId = req.body?.deviceId || null;
    const closed = ctx.webSocketHandler.closeVoiceFlow({ deviceId });
    res.json({ ok: true, closed, deviceId: deviceId || 'all' });
  });

  // 列在线设备（供控制器“选哪台小智”下拉；POST 统一口径）
  app.post('/api/voice/devices', (req, res) => {
    const auth = vfAuthorized(ctx.config, req);
    if (!auth.ok) return res.status(auth.code).json({ ok: false, error: auth.error });
    const targets = ctx.webSocketHandler ? ctx.webSocketHandler.getBroadcastTargets(null) : [];
    // 设备名优先级：hello 自报名 > Studio 设定名(xz_devices.name) > 板型友好名(model) > deviceId
    const store = ctx.webSocketHandler && ctx.webSocketHandler.store;
    const rowByKey = new Map();
    const rows = store && store.listDevices ? (store.listDevices({ limit: 500 }).items || []) : [];
    for (const r of rows) {
      const keys = [r.mac, ...(Array.isArray(r.device_ids) ? r.device_ids : [r.device_id])];
      for (const k of keys) if (k) rowByKey.set(String(k).toLowerCase(), r);
    }
    const devices = targets.map((d) => {
      const row = rowByKey.get(String(d.deviceId || '').toLowerCase());
      const name = (d.connection && d.connection.deviceName) || (row && row.name)
        || (row && BOARD_MODEL_NAMES[row.model]) || d.deviceId;
      return { deviceId: d.deviceId, clientId: d.clientId, name };
    });
    res.json({ ok: true, devices });
  });
}
