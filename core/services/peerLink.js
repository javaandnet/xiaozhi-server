/**
 * PeerLink — home<->cloud instance federation over an HTTP long-poll reverse channel.
 *
 * Topology: the home server sits behind NAT, so the home instance ("branch")
 * keeps an outbound long-poll against the public cloud instance ("hub").
 * Commands that must execute at home (broadcast/wake/homekit/mcp/masterpi-stream)
 * are enqueued on the hub, delivered on the next poll, executed by the branch via
 * loopback HTTP on its own port, and the result is posted back and resolved.
 *
 * Roles (config.json `peer` section):
 *   hub    (cloud)  serves /api/peer/poll|result|frame|camera/feed, dispatches to branch
 *   branch (home)   runs the poll loop, executes locally, pushes camera frames
 *
 * Security: every peer endpoint requires X-Peer-Key (constant-time compare) and
 * only paths on ALLOW_PREFIXES may be forwarded/executed (loopback injection guard).
 * Loop guard: forwarded requests carry `x-peer-via`; a request that already has it
 * is never re-forwarded.
 */
import crypto from 'crypto';

const ALLOW_PREFIXES = [
  '/api/broadcast',
  '/api/wake',
  '/api/homekit/',
  '/api/devices',
  '/api/mcp/',
  '/api/robot/',
  '/api/masterpi/stream/',
  '/api/masterpi/safety',
  '/api/masterpi/shutdown',
  '/api/masterpi/speak',
];

const POLL_HOLD_MS = 25000;      // branch long-poll hold (nginx proxy_read_timeout is 60s)
const BRANCH_ONLINE_MS = 60000;  // branch considered online if it polled within this window
const DEFAULT_DISPATCH_MS = 15000;
const MAX_QUEUE_MS = 30000;      // queued commands older than this are dropped on delivery
const MAX_FRAMES = 8 * 1024 * 1024; // refuse relayed frames above 8MB

function newReqId() {
  return `c_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

class PeerLink {
  /**
   * @param {Object} peerCfg - config.json `peer` section {enabled, role, hubUrl, key}
   * @param {Object} opts - { port } local HTTP port used for branch loopback execution
   */
  constructor(peerCfg = {}, opts = {}) {
    const cfg = peerCfg || {};
    this.enabled = cfg.enabled === true;
    this.role = String(cfg.role || '').toLowerCase(); // 'hub' | 'branch'
    this.hubUrl = String(cfg.hubUrl || '').replace(/\/+$/, '');
    this.key = String(cfg.key || '');
    this.localPort = Number(opts.port) || 8003;
    this.isHub = this.enabled && this.role === 'hub' && !!this.key;
    this.isBranch = this.enabled && this.role === 'branch' && !!this.hubUrl && !!this.key;

    // hub state
    this.lastPollAt = 0;
    this._waiters = [];   // [{res, timer}]
    this._queue = [];     // [{id, method, path, body, issuedAt}]
    this._pending = new Map(); // id -> {resolve, timer}
    this.latestFrame = null;   // Buffer of the most recent relayed JPEG
    this.frameSeq = 0;
    this.frameAt = 0;
    this.lastViewerAt = 0;     // any open/refreshed camera/feed connection counts as activity
    this.mcpService = null;    // hub-side: injected so poll responses piggyback robot provider snapshot

    // branch state
    this._running = false;
    this._abort = null;
    this._backoffMs = 2000;
    this._framePulling = false;
    this._frameAbort = null;
    this._lastPollError = null;
    this._remoteProviders = []; // robot providers (with tools) registered on the hub, relayed via poll
  }

  /* ---------------- shared ---------------- */

  isPathAllowed(path) {
    return ALLOW_PREFIXES.some((p) => String(path || '').startsWith(p));
  }

  keyOk(req) {
    const got = String(req.headers['x-peer-key'] || '');
    if (!got || !this.key) return false;
    const a = Buffer.from(got);
    const b = Buffer.from(this.key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  status() {
    if (!this.enabled) return null;
    if (this.isHub) return { role: 'hub', branch_online: this.branchOnline() };
    if (this.isBranch) return { role: 'branch', last_poll_error: this._lastPollError, frame_pulling: this._framePulling };
    return { role: this.role || 'none' };
  }

  /* ---------------- hub side ---------------- */

  /** hub-side: inject mcpService so each poll response can carry ready robot providers + tools. */
  setMcpService(mcpService) {
    this.mcpService = mcpService;
  }

  /** Serializable snapshot of this (hub) instance's ready robot bodies, tools included. */
  _snapshotRobotProviders() {
    if (!this.isHub || !this.mcpService || typeof this.mcpService.getDeviceProviderStatus !== 'function') return [];
    try {
      const st = this.mcpService.getDeviceProviderStatus();
      return (st.providers || [])
        .filter((p) => p.robot && p.ready)
        .map((p) => ({
          clientId: p.clientId, deviceId: p.deviceId, mac: p.mac, name: p.name,
          deviceType: p.deviceType, ready: true, toolCount: p.toolCount,
          tools: this.mcpService.getFunctionDescriptionsForProvider(p.mac || p.deviceId || p.clientId) || [],
        }));
    } catch { return []; }
  }

  /* ---------------- provider snapshot (cross-instance) ---------------- */

  /** Relay of hub robot providers cached on the branch; consumed by McpService for cross-instance routing. */
  getRemoteProviders() {
    return this._remoteProviders;
  }

  branchOnline() {
    return this.isHub && Date.now() - this.lastPollAt < BRANCH_ONLINE_MS;
  }

  wantFrames() {
    // viewers active within 8s keep the branch pulling frames
    return Date.now() - this.lastViewerAt < 8000;
  }

  /** Long-poll endpoint handler: GET /api/peer/poll */
  handlePoll(req, res) {
    if (!this.keyOk(req)) return res.status(401).json({ ok: false, error: 'bad peer key' });
    this.lastPollAt = Date.now();
    const deliver = (cmd) => {
      const idx = this._waiters.findIndex((wt) => wt.res === res);
      if (idx >= 0) this._waiters.splice(idx, 1);
      res.json({ cmd: cmd || null, want_frames: this.wantFrames(), providers: this._snapshotRobotProviders() });
    };
    const w = { res, timer: null, deliver };
    // drain expired queue entries, then take the first fresh command if any
    while (this._queue.length && Date.now() - this._queue[0].issuedAt > MAX_QUEUE_MS) this._queue.shift();
    if (this._queue.length) {
      const cmd = this._queue.shift();
      return deliver(cmd);
    }
    w.timer = setTimeout(() => deliver(null), POLL_HOLD_MS);
    this._waiters.push(w);
    req.on('close', () => {
      const idx = this._waiters.indexOf(w);
      if (idx >= 0) this._waiters.splice(idx, 1);
      if (w.timer) clearTimeout(w.timer);
    });
  }

  /** POST /api/peer/result */
  handleResult(req, res) {
    if (!this.keyOk(req)) return res.status(401).json({ ok: false, error: 'bad peer key' });
    const { id, status, body } = req.body || {};
    const p = this._pending.get(String(id));
    if (!p) return res.json({ ok: false, error: 'unknown or expired command id' });
    this._pending.delete(String(id));
    p.resolve({ httpStatus: Number(status) || 200, body: body == null ? null : body });
    res.json({ ok: true });
  }

  /** POST /api/peer/frame — binary JPEG pushed by the branch. */
  handleFrame(req, res) {
    if (!this.keyOk(req)) return res.status(401).json({ ok: false, error: 'bad peer key' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_FRAMES) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size || size > MAX_FRAMES) return res.status(400).json({ ok: false, error: 'empty or oversized frame' });
      this.latestFrame = Buffer.concat(chunks);
      this.frameSeq += 1;
      this.frameAt = Date.now();
      res.json({ ok: true });
    });
    req.on('error', () => { /* client abort: nothing to resolve */ });
  }

  /** Enqueue a command for the branch and await its result. */
  dispatch(method, path, body, timeoutMs = DEFAULT_DISPATCH_MS) {
    // GET/HEAD never carry a body (express parses {} for them — fetch would reject)
    const sendBody = /^(get|head)$/i.test(method) ? null : (body ?? null);
    return new Promise((resolve) => {
      if (!this.isHub) return resolve({ error: 'peer link not hub' });
      if (!this.isPathAllowed(path)) return resolve({ error: `path not allowed: ${path}` });
      if (!this.branchOnline()) return resolve({ error: 'branch offline' });
      const id = newReqId();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ error: `peer timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      this._pending.set(id, { resolve, timer });
      const cmd = { id, method, path, body: sendBody, issuedAt: Date.now() };
      const w = this._waiters.shift();
      if (w) {
        if (w.timer) clearTimeout(w.timer);
        w.deliver(cmd);
      } else {
        this._queue.push(cmd);
      }
    });
  }

  /* ---------------- branch side ---------------- */

  start() {
    if (!this.isBranch || this._running) return;
    this._running = true;
    this._loop();
    console.log('[PeerLink] branch loop started -> hub', this.hubUrl);
  }

  stop() {
    this._running = false;
    if (this._abort) this._abort.abort();
    if (this._frameAbort) this._frameAbort.abort();
    this._framePulling = false;
  }

  async _loop() {
    while (this._running) {
      let poll = null;
      try {
        const ac = new AbortController();
        this._abort = ac;
        const t = setTimeout(() => ac.abort(), POLL_HOLD_MS + 10000);
        const r = await fetch(`${this.hubUrl}/api/peer/poll`, {
          headers: { 'X-Peer-Key': this.key },
          signal: ac.signal,
        });
        clearTimeout(t);
        if (r.status === 401) {
          this._lastPollError = 'peer key rejected by hub';
          console.error('[PeerLink] peer key rejected by hub — check config.json peer.key on both sides');
        } else {
          poll = await r.json();
          this._lastPollError = null;
          this._backoffMs = 2000;
          // cache hub robot-provider snapshot for cross-instance voice/console routing
          if (poll && Array.isArray(poll.providers)) this._remoteProviders = poll.providers;
        }
      } catch (e) {
        this._lastPollError = e.message;
        // hub unreachable / abort: back off exponentially
      }
      if (!this._running) break;
      if (poll) {
        this._syncFrames(poll.want_frames === true);
        if (poll.cmd) await this._execCommand(poll.cmd);
      } else {
        await this._sleep(this._backoffMs);
        this._backoffMs = Math.min(30000, this._backoffMs * 2);
      }
    }
  }

  /** Execute one forwarded command against the local API and post back the result. */
  async _execCommand(cmd) {
    const { id, method, path, body } = cmd;
    let httpStatus = 500;
    let respBody = null;
    if (!this.isPathAllowed(path)) {
      respBody = { success: false, error: `path not allowed: ${path}` };
      httpStatus = 403;
    } else {
      try {
        const noBody = /^(get|head)$/i.test(method);
        const headers = { 'x-peer-via': 'home' };
        if (!noBody) headers['Content-Type'] = 'application/json';
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 60000); // MCP/homekit pair can run long
        const r = await fetch(`http://127.0.0.1:${this.localPort}${path}`, {
          method,
          headers,
          body: noBody || body == null ? undefined : JSON.stringify(body),
          signal: ac.signal,
        });
        clearTimeout(t);
        httpStatus = r.status;
        try { respBody = await r.json(); } catch { respBody = { raw: await r.text().catch(() => '') }; }
      } catch (e) {
        respBody = { success: false, error: `local exec failed: ${e.message}` };
        httpStatus = 502;
      }
    }
    try {
      await fetch(`${this.hubUrl}/api/peer/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Peer-Key': this.key },
        body: JSON.stringify({ id, status: httpStatus, body: respBody }),
      });
    } catch (e) {
      console.warn(`[PeerLink] result post failed for ${id}: ${e.message}`);
    }
  }

  /** Direct home->cloud call used for reverse forwarding (loop-guarded upstream). */
  async callHub(method, path, body, timeoutMs = DEFAULT_DISPATCH_MS) {
    if (!this.isBranch) return { error: 'peer link not branch' };
    if (!this.isPathAllowed(path)) return { error: `path not allowed: ${path}` };
    const sendBody = /^(get|head)$/i.test(method) ? null : (body ?? null);
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetch(`${this.hubUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-peer-via': 'home' },
        body: sendBody == null ? undefined : JSON.stringify(sendBody),
        signal: ac.signal,
      });
      clearTimeout(t);
      let parsed = null;
      try { parsed = await r.json(); } catch { parsed = null; }
      return { httpStatus: r.status, body: parsed };
    } catch (e) {
      return { error: `hub call failed: ${e.message}` };
    }
  }

  /** Fetch a peer resource (GET) directly — used for the merged online view. */
  async hubGet(path, timeoutMs = 8000) {
    if (!this.isBranch) return null;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetch(`${this.hubUrl}${path}`, { headers: { 'x-peer-via': 'home' }, signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  /* ---------------- branch frame puller (camera relay) ---------------- */

  _syncFrames(want) {
    if (want && !this._framePulling) {
      this._framePulling = true;
      this._frameLoop();
      console.log('[PeerLink] camera frame relay started (hub viewer active)');
    } else if (!want && this._framePulling) {
      this._framePulling = false;
      if (this._frameAbort) this._frameAbort.abort(); // 断开长连接,loop 自行收尾
      console.log('[PeerLink] camera frame relay stopped (no hub viewers)');
    }
  }

  /**
   * 帧中继：单条长连接订阅家里 /stream(MJPEG),连续切帧后按 ~400ms 节拍推 hub。
   * 旧实现每拍新建连接取一帧,400ms 节拍下几乎全部耗在握手+首帧等待上,
   * 实测反而低于 1fps;长连接一次握手持续出帧,节流只作用于推 hub 侧。
   */
  async _frameLoop() {
    const SOI = Buffer.from([0xff, 0xd8]);
    const EOI = Buffer.from([0xff, 0xd9]);
    let backoff = 2000;
    while (this._framePulling && this._running) {
      const ac = new AbortController();
      this._frameAbort = ac;
      try {
        const st = await this._localGet('/api/masterpi/stream/status');
        let url = st && st.url;
        if (st && !st.running) {
          const s = await this._localPost('/api/masterpi/stream/start');
          if (s && s.ok) url = s.url;
        }
        if (!url || ac.signal.aborted) {
          await this._sleep(backoff);
          continue;
        }
        backoff = 2000;
        const r = await fetch(`${url}stream`, { signal: ac.signal });
        if (!r.ok || !r.body) throw new Error(`stream http ${r.status}`);
        const reader = r.body.getReader();
        let buf = Buffer.alloc(0);
        let lastPost = 0;
        while (this._framePulling && this._running) {
          const { done, value } = await reader.read();
          if (done) break;
          buf = Buffer.concat([buf, Buffer.from(value)]);
          if (buf.length > 8 * 1024 * 1024) buf = buf.subarray(-2 * 1024 * 1024); // 防失控
          let soi; let eoi;
          while ((soi = buf.indexOf(SOI)) >= 0 && (eoi = buf.indexOf(EOI, soi)) > 0) {
            if (lastPost && Date.now() - lastPost < 400) {
              // 未到推帧节拍: 帧留在缓冲头部,不丢弃(用普通 sleep,避免被 poll 控制器中断)
              await new Promise((res) => setTimeout(res, 400 - (Date.now() - lastPost)));
              continue;
            }
            const frame = buf.subarray(soi, eoi + 2);
            buf = buf.subarray(eoi + 2);
            try {
              await fetch(`${this.hubUrl}/api/peer/frame`, {
                method: 'POST',
                headers: { 'X-Peer-Key': this.key, 'Content-Type': 'image/jpeg' },
                body: frame,
                signal: AbortSignal.timeout(10000),
              });
              lastPost = Date.now();
            } catch { /* hub hiccup: 下帧再推 */ }
          }
        }
        await reader.cancel().catch(() => {});
      } catch (e) {
        if (this._framePulling) {
          console.debug(`[PeerLink] frame relay iteration failed: ${e.message}`);
          await this._sleep(backoff);
          backoff = Math.min(15000, backoff * 2);
        }
      } finally {
        if (this._frameAbort === ac) this._frameAbort = null;
      }
    }
    this._framePulling = false;
  }

  async _localGet(path) {
    try {
      const r = await fetch(`http://127.0.0.1:${this.localPort}${path}`);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  async _localPost(path) {
    try {
      const r = await fetch(`http://127.0.0.1:${this.localPort}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-peer-via': 'home' },
        body: '{}',
      });
      return await r.json().catch(() => null);
    } catch { return null; }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      const un = () => { clearTimeout(t); resolve(); };
      if (this._abort) this._abort.signal.addEventListener('abort', un, { once: true });
    });
  }
}

export default PeerLink;
