/**
 * Broadcast & remote-wake routes (unauthenticated LAN / proxy control).
 * Extracted verbatim from index.js setupRoutes; behavior unchanged.
 * Peer-link federation: when this instance has no local target device and the
 * request did not already arrive via the peer channel, forward to the other
 * instance (hub -> branch dispatch queue, branch -> direct hub call).
 */

/** Resolve the peer forward route for a request; null when local-only. */
function peerFor(ctx, req) {
  const link = ctx.peerLink;
  if (!link || (!link.isHub && !link.isBranch)) return null;
  if (req.headers['x-peer-via']) return null; // loop guard: served locally
  return link;
}

/** Forward a JSON command to the peer; returns {via, httpStatus, body} or {error}. */
async function forwardPeer(link, method, path, body) {
  if (link.isHub) {
    const r = await link.dispatch(method, path, body);
    if (r.error) return r;
    return { via: 'home', httpStatus: r.httpStatus, body: r.body };
  }
  const r = await link.callHub(method, path, body);
  if (r.error) return r;
  return { via: 'cloud', httpStatus: r.httpStatus, body: r.body };
}

export function registerBroadcastRoutes(app, ctx) {
  // 语音放送 API（由 Gala Web /api/channels/xiaozhi/broadcast 代理调用，
  // 也供局域网内直接推送）。合成+推流耗时，先验设备再受理后异步发送。
  app.post('/api/broadcast', async (req, res) => {
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
      const link = peerFor(ctx, req);
      if (link) {
        const r = await forwardPeer(link, 'POST', '/api/broadcast', req.body);
        if (!r.error) {
          console.log(`[xiaozhi] broadcast forwarded via peer (${r.via})`);
          return res.status(r.httpStatus).json({ ...(r.body || {}), via: r.via });
        }
        console.warn(`[xiaozhi] broadcast peer forward failed: ${r.error}`);
        return res.status(404).json({ success: false, error: '没有在线的小智设备', peer: r.error });
      }
      return res.status(404).json({ success: false, error: '没有在线的小智设备' });
    }
    ctx.webSocketHandler.broadcastToDevices(text, { deviceId })
      .then(r => console.log(`[xiaozhi] broadcast done: ${JSON.stringify(r)}`))
      .catch(e => console.error('[xiaozhi] broadcast failed:', e.message));
    res.json({ success: true, accepted: true, devices: targets.length, message: 'broadcast queued' });
  });

  // 远程唤醒 API：退出休息模式 + 下发 wake 指令 + 确认播报。
  app.post('/api/wake', async (req, res) => {
    if (!ctx.webSocketHandler) {
      return res.status(500).json({ success: false, error: 'WebSocket handler 未初始化' });
    }
    const deviceId = req.body?.deviceId || null;
    const announce = req.body?.announce;
    ctx.webSocketHandler.wakeDevices({
      deviceId,
      ...(announce !== undefined ? { announce: String(announce) } : {})
    })
      .then(async (r) => {
        if (r.woken === 0) {
          const link = peerFor(ctx, req);
          if (link) {
            const f = await forwardPeer(link, 'POST', '/api/wake', req.body);
            if (!f.error) {
              console.log(`[xiaozhi] wake forwarded via peer (${f.via})`);
              return res.status(f.httpStatus).json({ ...(f.body || {}), via: f.via });
            }
            console.warn(`[xiaozhi] wake peer forward failed: ${f.error}`);
            return res.status(404).json({ success: false, error: '没有在线的小智设备', peer: f.error });
          }
          return res.status(404).json({ success: false, error: '没有在线的小智设备' });
        }
        console.log(`[xiaozhi] wake done: ${JSON.stringify(r)}`);
        res.json({ success: true, devices: r.woken, message: 'wake sent' });
      })
      .catch(e => res.status(500).json({ success: false, error: e.message }));
  });
}
