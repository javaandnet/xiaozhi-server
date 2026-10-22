/**
 * Broadcast & remote-wake routes (unauthenticated LAN / proxy control).
 * Extracted verbatim from index.js setupRoutes; behavior unchanged.
 */
export function registerBroadcastRoutes(app, ctx) {
  // 语音放送 API（由 Gala Web /api/channels/xiaozhi/broadcast 代理调用，
  // 也供局域网内直接推送）。合成+推流耗时，先验设备再受理后异步发送。
  app.post('/api/broadcast', (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ success: false, error: 'text 不能为空' });
    }
    if (!ctx.webSocketHandler) {
      return res.status(500).json({ success: false, error: 'WebSocket handler 未初始化' });
    }
    const deviceId = req.body?.deviceId || null;
    const targets = ctx.webSocketHandler.getBroadcastTargets(deviceId);
    if (targets.length === 0) {
      return res.status(404).json({ success: false, error: '没有在线的小智设备' });
    }
    ctx.webSocketHandler.broadcastToDevices(text, { deviceId })
      .then(r => console.log(`[xiaozhi] broadcast done: ${JSON.stringify(r)}`))
      .catch(e => console.error('[xiaozhi] broadcast failed:', e.message));
    res.json({ success: true, accepted: true, devices: targets.length, message: 'broadcast queued' });
  });

  // 远程唤醒 API：退出休息模式 + 下发 wake 指令 + 确认播报。
  app.post('/api/wake', (req, res) => {
    if (!ctx.webSocketHandler) {
      return res.status(500).json({ success: false, error: 'WebSocket handler 未初始化' });
    }
    const deviceId = req.body?.deviceId || null;
    const announce = req.body?.announce;
    ctx.webSocketHandler.wakeDevices({
      deviceId,
      ...(announce !== undefined ? { announce: String(announce) } : {})
    })
      .then(r => {
        if (r.woken === 0) return res.status(404).json({ success: false, error: '没有在线的小智设备' });
        console.log(`[xiaozhi] wake done: ${JSON.stringify(r)}`);
        res.json({ success: true, devices: r.woken, message: 'wake sent' });
      })
      .catch(e => res.status(500).json({ success: false, error: e.message }));
  });
}
