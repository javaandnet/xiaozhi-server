/**
 * Peer-link routes: hub-side federation endpoints + main-channel MasterPi
 * stream control (loopback target for branch execution and the console).
 *
 *   hub only   GET  /api/peer/poll | POST /api/peer/result | POST /api/peer/frame
 *   hub only   GET  /api/peer/camera/feed   (relayed JPEG as multipart, session/key auth)
 *   hub only   GET  /api/peer/camera/shot   (watch snapshot via peer command channel)
 *   both       GET  /api/masterpi/stream/status | POST .../start | POST .../stop
 *              POST /api/masterpi/stream/mode | GET .../watch/events | GET .../watch/shot
 *              GET/POST .../watch/announce  (per-instance config, home-side poller)
 *   both       GET/POST /api/masterpi/safety
 *              POST /api/masterpi/speak  (push text to the bound xiaozhi voice device,
 *                                         same announce path as /api/voice/speak)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  streamStatus, streamStart, streamStop, streamSetMode,
  watchEvents, watchShot, getSafety, setSafety, shutdownPi,
  restartClient, target as piTarget,
} from '../../studio/lib/masterpi.js';
import { studioConfig } from '../../studio/config.js';
import { consoleSessionUser } from '../../studio/routes.js';
import { IK_HOME, IK_STEPS, clampPose, getOrigin } from '../services/ikJog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PART_HEADER = Buffer.from('\r\n--peerframe\r\nContent-Type: image/jpeg\r\n\r\n');

// Watch announce per-instance state (home-side LAN poller; cursor into pi events).
const watch = { timer: null, cursor: 0, lastPollAt: 0 };

export function registerPeerRoutes(app, ctx) {
  const link = ctx.peerLink;

  // ---- hub-side transport endpoints (branch is client-only) ----
  if (link && link.isHub) {
    app.get('/api/peer/poll', (req, res) => link.handlePoll(req, res));
    app.post('/api/peer/result', (req, res) => link.handleResult(req, res));
    app.post('/api/peer/frame', (req, res) => link.handleFrame(req, res));

    // Stream control, watch queries and the chassis-safety switch are Pi-SSH
    // based → must execute at home while branch is online.
    app.use('/api/masterpi', async (req, res, next) => {
      if (req.headers['x-peer-via'] || !link.branchOnline()) return next();
      const sub = req.path; // e.g. '/stream/status', '/safety'
      if (!sub.startsWith('/stream') && sub !== '/safety' && sub !== '/shutdown') return next();
      if (sub === '/stream/watch/shot') {
        // Snapshot bytes can't ride the JSON command channel raw: ask the branch
        // for the base64 variant, decode here, serve image/jpeg.
        const name = encodeURIComponent(req.query.name || '');
        const r = await link.dispatch('GET', `/api/masterpi/stream/watch/shot?b64=1&name=${name}`, null, 30000);
        if (r.error || !r.body || !r.body.ok || !r.body.data) {
          console.warn(`[xiaozhi] watch shot peer forward failed: ${r.error || 'empty'}`);
          return next();
        }
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'no-store');
        return res.end(Buffer.from(r.body.data, 'base64'));
      }
      const r = await link.dispatch(req.method, '/api/masterpi' + req.path, req.body ?? null, 30000);
      if (r.error) {
        console.warn(`[xiaozhi] masterpi stream peer forward failed (${req.path}): ${r.error}`);
        return next();
      }
      return res.status(r.httpStatus).json({ ...(r.body || {}), via: 'home' });
    });

    // Camera relay out: re-serve the latest branch frame as multipart/x-mixed-replace.
    // Auth: console session cookie OR X-Peer-Key (frames are sensitive; never public).
    app.get('/api/peer/camera/feed', (req, res) => {
      const ok = link.keyOk(req) || !!consoleSessionUser(studioConfig, req);
      if (!ok) return res.status(401).json({ ok: false, error: 'login required' });
      res.setHeader('Content-Type', 'multipart/x-mixed-replace;boundary=peerframe');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      link.lastViewerAt = Date.now();
      let lastSeq = -1;
      let closed = false;
      const tick = setInterval(() => {
        if (closed) return;
        link.lastViewerAt = Date.now();
        if (link.frameSeq !== lastSeq && link.latestFrame) {
          lastSeq = link.frameSeq;
          res.write(PART_HEADER);
          res.write(link.latestFrame);
        }
      }, 400);
      req.on('close', () => {
        closed = true;
        clearInterval(tick);
      });
    });

    // Watch snapshot read-back (out-and-about): latest JPEG via the command
    // channel, same auth posture as the relay feed.
    app.get('/api/peer/camera/shot', async (req, res) => {
      const ok = link.keyOk(req) || !!consoleSessionUser(studioConfig, req);
      if (!ok) return res.status(401).json({ ok: false, error: 'login required' });
      const name = String(req.query.name || '');
      const r = await link.dispatch('GET', `/api/masterpi/stream/watch/shot?b64=1&name=${encodeURIComponent(name)}`, null, 30000);
      if (r.error) return res.status(502).json({ ok: false, error: r.error });
      if (!r.body || !r.body.ok || !r.body.data) return res.status(404).json({ ok: false, error: 'shot not found' });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.end(Buffer.from(r.body.data, 'base64'));
    });
  }

  // ---- MasterPi MJPEG preview control on the main channel ----
  // (studio console uses /firmware/api/masterpi/*; branch loopback and iOS need
  //  the same capability on the unauthenticated LAN control port.)
  app.get('/api/masterpi/stream/status', (_req, res) => {
    try { res.json({ ok: true, ...streamStatus(studioConfig) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/masterpi/stream/start', (req, res) => {
    try { res.json(streamStart(studioConfig, (req.body || {}).mode)); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/masterpi/stream/stop', (_req, res) => {
    try { res.json(streamStop(studioConfig)); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });
  app.post('/api/masterpi/stream/mode', (req, res) => {
    try { res.json(streamSetMode(studioConfig, (req.body || {}).mode)); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ---- Watch (看家) queries on the main channel ----
  app.get('/api/masterpi/stream/watch/events', (req, res) => {
    try { res.json(watchEvents(studioConfig, req.query.since)); }
    catch (e) { res.json({ ok: false, error: e.message, events: [] }); }
  });
  // Local (home/LAN) serves raw bytes; ?b64=1 wraps as JSON for the peer
  // command channel (hub decodes and re-serves image/jpeg).
  app.get('/api/masterpi/stream/watch/shot', (req, res) => {
    try {
      const r = watchShot(studioConfig, req.query.name);
      if (!r.ok) return res.status(404).json({ ok: false, error: r.error });
      if (req.query.b64 === '1') return res.json({ ok: true, data: r.jpeg.toString('base64') });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(r.jpeg);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Announce switch: persisted in this instance's config.json masterpi.watch
  // section; the poller runs where the Pi is reachable (home/branch instance).
  const watchCfg = () => ({
    announce: false, intervalSec: 10, ...(studioConfig.masterpi && studioConfig.masterpi.watch || {}),
  });
  app.get('/api/masterpi/stream/watch/announce', (_req, res) => {
    res.json({ ok: true, ...watchCfg() });
  });
  app.post('/api/masterpi/stream/watch/announce', (req, res) => {
    const body = req.body || {};
    try {
      studioConfig.masterpi = studioConfig.masterpi || {};
      const cur = watchCfg();
      studioConfig.masterpi.watch = {
        announce: body.announce === true,
        intervalSec: Math.min(Math.max(Number(body.intervalSec) || cur.intervalSec, 5), 300),
        cooldownSec: cur.cooldownSec,
      };
      const cfgPath = (ctx && ctx.configPath) || path.join(__dirname, '..', '..', 'config.json');
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      raw.masterpi = raw.masterpi || {};
      raw.masterpi.watch = studioConfig.masterpi.watch;
      fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
      if (studioConfig.masterpi.watch.announce) ensureWatchPoller(ctx);
      res.json({ ok: true, ...studioConfig.masterpi.watch });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ---- Robot safety switch (robot.allowChassis on the Pi; default false = wheels locked) ----
  app.get('/api/masterpi/safety', (_req, res) => {
    try { res.json(getSafety(studioConfig)); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/masterpi/safety', (req, res) => {
    try { res.json(setSafety(studioConfig, (req.body || {}).allowChassis === true)); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Graceful robot power-off (SSH shutdown -h on the Pi; the box stops pinging
  // back within seconds and needs a physical power-on to come back).
  app.post('/api/masterpi/shutdown', (_req, res) => {
    try { res.json(shutdownPi(studioConfig)); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Push text to a xiaozhi voice device for TTS announce (UI entry on the robot
  // gamepad). Same wake-then-announce path as /api/voice/speak but session-auth'd
  // via the console, no X-Xiaozhi-Key needed. The voice device is resolved from the
  // one-to-one binding (settings.robot.body), not hand-picked: deviceId wins if given,
  // otherwise every online device whose settings.robot.body === body is targeted.
  app.post('/api/masterpi/speak', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text 不能为空' });
    const wsh = ctx.webSocketHandler;
    if (!wsh) return res.status(500).json({ ok: false, error: 'WebSocket handler 未初始化' });
    let deviceId = req.body?.deviceId || null;
    const body = String(req.body?.body || 'masterpi-0001').toLowerCase();
    // 1) 优先从本地在线连接解析绑定的语音设备（_resolveBoundVoiceDevice 带 store 查库兜底 + 小写归一）
    if (!deviceId) deviceId = wsh._resolveBoundVoiceDevice ? wsh._resolveBoundVoiceDevice(body) : null;
    // 2) 本地连接未命中：回退查本机 store 绑定关系（语音设备可能连在对端实例）
    if (!deviceId && ctx.store && typeof ctx.store.findVoiceDeviceByBody === 'function') {
      deviceId = ctx.store.findVoiceDeviceByBody(body);
    }
    if (!deviceId) {
      return res.status(404).json({ ok: false, error: `没有小智设备绑定到机器人 ${body}（先在设备设置里绑定控制硬件）` });
    }
    // 3) 解析到的设备若本地在线，直接本地唤醒+放送
    const targets = wsh.getBroadcastTargets(deviceId);
    if (targets.length === 0) {
      // 本地无连接：带 deviceId 转发到持有连接的对端（x-peer-via 防成环）
      const link = ctx.peerLink;
      const viaPeer = req.headers['x-peer-via'];
      if (link && !viaPeer && (link.isHub || link.isBranch)) {
        const r = link.isHub
          ? await link.dispatch('POST', '/api/masterpi/speak', { deviceId, text }, 30000)
          : await link.callHub('POST', '/api/masterpi/speak', { deviceId, text });
        if (!r.error && r.body && r.body.ok) {
          console.log(`[xiaozhi] gamepad speak forwarded via peer (${link.isHub ? 'home' : 'cloud'}) -> ${deviceId}`);
          return res.status(r.httpStatus || 200).json({ ...r.body, via: link.isHub ? 'home' : 'cloud' });
        }
        return res.status(404).json({ ok: false, error: '绑定的小智设备当前不在线', peer: r.error || (r.body && r.body.error) || 'forward failed' });
      }
      return res.status(404).json({ ok: false, error: '设备不在线或未找到' });
    }
    wsh.wakeDevices({ deviceId, announce: text, keepRest: true })
      .then((r) => console.log(`[xiaozhi] gamepad speak queued: ${JSON.stringify(r)}`))
      .catch((e) => console.error('[xiaozhi] gamepad speak failed:', e.message));
    res.json({ ok: true, accepted: true, deviceId, devices: targets.length });
  });

  // IK 微调（机械臂末端 jog）：基准由 server 统一维护（Web/iOS 共用一份），
  // 方向语义→机体系符号与安全盒限幅都收口在这里（见 services/ikJog.js）。
  // dir: up/down/forward/back/left/right/home；连续动作后基准未知，须先显式回位。
  app.post('/api/masterpi/ik/jog', async (req, res) => {
    try {
      const body = String(req.body?.body || '').toLowerCase();
      const dir = String(req.body?.dir || '');
      if (!body) return res.status(400).json({ ok: false, error: 'body 必填' });
      if (dir !== 'home' && !IK_STEPS[dir]) return res.status(400).json({ ok: false, error: `未知方向: ${dir}` });
      let target;
      if (dir === 'home') {
        target = { ...IK_HOME };
      } else {
        const cur = getOrigin(body);
        if (!cur) {
          return res.json({ ok: false, needHome: true, error: '手臂位置未知（执行过连续动作），请先按「回位」再微调' });
        }
        const s = IK_STEPS[dir];
        target = clampPose({ x: cur.x + (s.dx || 0), y: cur.y + (s.dy || 0), z: cur.z + (s.dz || 0) });
      }
      const stubConn = { clientId: '__http_ikjog__', features: { mcp: true }, send: () => {} };
      // 真实执行后由 callDeviceMcpTool 内部同步推进基准（见 ikJog.noteToolResult）
      const raw = await ctx.mcpService.callDeviceMcpTool(stubConn, 'robot_arm_ik', target, 30, body);
      let r = null;
      try { r = JSON.parse(String(raw)); } catch { /* 非 JSON 按成功处理 */ }
      if (r && r.ok === false) return res.json({ ok: false, error: r.error || 'arm_ik 执行失败' });
      if (r && r.found === false) return res.json({ ok: false, error: 'IK 无解（可能贴近边界），请换方向或回位' });
      res.json({ ok: true, body, pose: target });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // 重连身体：SSH 重启派侧 masterpi-client（僵尸 TCP 假在线时 provider 永不出现，
  // 相机直连却正常——云台/微调报“无法连接”的一键自愈入口，Web/iOS 均有按钮）。
  app.post('/api/masterpi/reconnect', (_req, res) => {
    try { res.json(restartClient(studioConfig)); }
    catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Boot-time poller start when announce was already enabled (home instance).
  if (watchCfg().announce) ensureWatchPoller(ctx);
  ensureClientWatchdog(ctx);
}

/**
 * Body-MCP zombie watchdog: after a server restart the Pi may keep a half-dead
 * TCP (no RST seen) so its supervisor never reconnects and the robot provider
 * never registers. If no robot provider is ready 60s after start, SSH-restart
 * the Pi client once per 10min window. Idempotent; logs in English.
 */
const clientWatch = { timer: null, startedAt: Date.now(), lastKick: 0 };
export function ensureClientWatchdog(ctx) {
  if (clientWatch.timer) return;
  clientWatch.timer = setInterval(() => {
    try {
      const now = Date.now();
      if (now - clientWatch.startedAt < 60_000) return; // grace: normal reconnect takes seconds
      if (now - clientWatch.lastKick < 600_000) return; // kick cooldown 10min
      const st = ctx.mcpService && ctx.mcpService.getDeviceProviderStatus && ctx.mcpService.getDeviceProviderStatus();
      if (st && st.robotReadyProviders > 0) return; // body online, nothing to do
      clientWatch.lastKick = now; // mark attempt even on failure to avoid hammering a dead Pi
      console.warn('[peer] robot provider absent after boot, SSH-restarting masterpi-client on the Pi (zombie-session recovery)');
      const r = restartClient(studioConfig);
      console.log(`[peer] masterpi-client restart result: ${JSON.stringify(r)}`);
    } catch (e) {
      console.warn('[peer] client watchdog kick failed:', e.message);
    }
  }, 30_000);
  clientWatch.timer.unref?.();
}

/**
 * Home-side watch announce poller: LAN-direct poll of the Pi's /watch/events
 * every intervalSec; fresh events (since process-start cursor, so historical
 * events never announce) go through the local broadcast path. Idempotent.
 */
export function ensureWatchPoller(ctx) {
  if (watch.timer) return;
  if (!watchCfgLive().announce) return;
  const t = piTarget(studioConfig);
  watch.cursor = Date.now() / 1000; // only events after startup
  // 1s 心跳、按当拍配置判定间隔:改 intervalSec/开关 announce 均无需重启生效。
  watch.timer = setInterval(async () => {
    try {
      const cfg = watchCfgLive();
      if (!cfg.announce) return; // switched off at runtime: idle, no traffic
      const intervalMs = Math.min(Math.max(cfg.intervalSec, 5), 300) * 1000;
      if (Date.now() - watch.lastPollAt < intervalMs) return;
      watch.lastPollAt = Date.now();
      const r = await fetch(`http://${t.host}:${t.streamPort}/watch/events?since=${watch.cursor}`, { signal: AbortSignal.timeout(5000) });
      const events = await r.json();
      if (!Array.isArray(events) || !events.length) return;
      watch.cursor = Math.max(...events.map((e) => Number(e.ts) || 0));
      const text = '看家相机检测到画面变化';
      let sent = false;
      if (ctx.webSocketHandler && typeof ctx.webSocketHandler.broadcastToDevices === 'function') {
        const targets = ctx.webSocketHandler.getBroadcastTargets(null);
        if (targets.length) {
          await ctx.webSocketHandler.broadcastToDevices(text, { deviceId: null });
          sent = true;
          console.log(`[xiaozhi] watch announce -> ${targets.length} device(s)`);
        }
      }
      if (!sent && ctx.peerLink && ctx.peerLink.isBranch) {
        // 本地无在线设备：经 peer 链路交给云端广播（设备漂在云端时不断通知）
        const r = await ctx.peerLink.callHub('POST', '/api/broadcast', { text });
        if (!r.error) { sent = true; console.log('[xiaozhi] watch announce forwarded via cloud peer'); }
        else console.warn(`[xiaozhi] watch announce peer forward failed: ${r.error}`);
      }
    } catch (e) { console.warn(`[xiaozhi] watch poller iteration failed: ${e.message}`); /* Pi offline: retry next tick */ }
  }, 1000);
  console.log('[xiaozhi] watch announce poller started');
}

function watchCfgLive() {
  return { announce: false, intervalSec: 10, ...(studioConfig.masterpi && studioConfig.masterpi.watch || {}) };
}
