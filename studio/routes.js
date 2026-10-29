/**
 * Firmware Studio — API router for the standalone xiaozhi-server.
 * Mounted by run-server.js at /firmware/api.
 * Contract consumed by the SFC console (studio/web -> public/app): raw library
 * results (NOT wrapped), build logs via the global util.SSE at /events,
 * sync/flash as per-request SSE.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SSE } from './lib/util.js';
import {
  authEnabled, ensureDefaultAdmin, getSecret, verifyUser, userExists,
  listUsers, addUser, deleteUser, setPassword,
} from './lib/users.js';
import { probeEnv, listBoards, listDevices, detectBoard, checkOfficial } from './lib/env.js';
import { startBuild, getJob, listJobs } from './lib/build.js';
import { listInstalled, installFirmware, removeFirmware, flashUsb, syncSource } from './lib/install.js';
import { getConnection, setConnection, getServiceStatus, streamStart, streamStop, streamStatus, facesList, facesDelete, facesRename, facesFaceLogin, facesThreshold } from './lib/masterpi.js';
import { INBOUND_CAPABILITIES, OUTBOUND_CAPABILITIES, isKnownCapability, capabilityDirection } from '../core/utils/externalCapabilities.js';

function sseHead(res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
}
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

function streamAction(res, fn) {
  sseHead(res);
  const onLine = (line) => sse(res, { line });
  Promise.resolve()
    .then(() => fn(onLine))
    .then((r) => sse(res, { done: true, ok: r?.ok, code: r?.code, error: r?.error, message: r?.message, needConfirm: r?.needConfirm }))
    .catch((e) => sse(res, { done: true, ok: false, error: e.message }))
    .finally(() => res.end());
}

/**
 * Login brute-force guard: per-client-IP failure window with lockout.
 * Policy: LOCK_GUARD.maxFails failures within windowMs -> block the IP for lockMs.
 * In-memory only (restart clears locks). Success resets the counter.
 * Client IP: our nginx sets X-Forwarded-For as "$remote_addr:$remote_port"
 * (non-standard, Express trust proxy would misparse), so parse it manually;
 * direct local access has no XFF -> fall back to the socket address.
 */
const LOGIN_GUARD = { maxFails: 5, windowMs: 10 * 60 * 1000, lockMs: 15 * 60 * 1000 };
const loginFails = new Map(); // ip -> { count, first, lockedUntil }

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) {
    const m = xff.match(/^(\d+\.\d+\.\d+\.\d+)(:\d+)?$/); // strip ":port" suffix
    return m ? m[1] : xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

function guardCheck(ip, guard) {
  const st = loginFails.get(ip);
  if (!st) return { blocked: false };
  const now = Date.now();
  if (st.lockedUntil) {
    if (now < st.lockedUntil) return { blocked: true, retryAfterSec: Math.ceil((st.lockedUntil - now) / 1000) };
    loginFails.delete(ip); // lock expired, start clean
    return { blocked: false };
  }
  if (now - st.first > guard.windowMs) loginFails.delete(ip); // window elapsed
  return { blocked: false };
}

function guardRecordFail(ip, guard) {
  if (loginFails.size > 1000) {
    const now = Date.now();
    for (const [k, v] of loginFails) if (now - (v.lockedUntil || v.first) > guard.lockMs) loginFails.delete(k);
  }
  const st = loginFails.get(ip);
  const now = Date.now();
  if (!st || now - st.first > guard.windowMs) {
    loginFails.set(ip, { count: 1, first: now, lockedUntil: 0 });
    return { locked: false, count: 1 };
  }
  st.count += 1;
  if (st.count >= guard.maxFails) {
    st.lockedUntil = now + guard.lockMs;
    console.warn(`[LoginGuard] IP ${ip} locked for ${guard.lockMs / 60000}min after ${st.count} failed logins`);
    return { locked: true, count: st.count };
  }
  return { locked: false, count: st.count };
}

/** Session token: base64url("<username>|<expiryMs>.<hmac>") keyed by the persisted secret */
function makeToken(cfg, username, ttlMs = 7 * 24 * 3600 * 1000) {
  const payload = `${username}|${Date.now() + ttlMs}`;
  const sig = crypto.createHmac('sha256', getSecret(cfg)).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}
function tokenUser(cfg, req) {
  const m = (req.headers.cookie || '').match(/xzmanage=([^;]+)/);
  if (!m) return null;
  try {
    const raw = Buffer.from(m[1], 'base64url').toString('utf8');
    const [ident, sig] = raw.split('.');
    const [username, exp] = String(ident).split('|');
    if (!username || !exp || Date.now() > Number(exp)) return null;
    const expect = crypto.createHmac('sha256', getSecret(cfg)).update(ident).digest('hex');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    // Deleted users must lose access immediately
    return userExists(cfg, username) ? username : null;
  } catch (e) { return null; }
}

/** Console session check for non-/firmware mounts (peer camera relay). */
export function consoleSessionUser(cfg, req) {
  if (!authEnabled(cfg)) return 'anonymous';
  return tokenUser(cfg, req);
}

/**
 * Auth middleware for the /firmware console (mounted before static/api).
 * Open access only when no manage.password is set AND no user store exists.
 */
// The built console (studio/web -> public/app) needs its login page and hashed
// asset bundle readable before a session exists, otherwise login cannot render.
const PUBLIC_APP_PATHS = /^\/app\/(login\.html|assets\/)/;

export function createManageAuth(cfg) {
  return (req, res, next) => {
    const p = req.path;
    // Keep whatever external prefix the request came with (/xiaozhi on cloud, empty locally)
    const pre = String(req.originalUrl || '').startsWith('/xiaozhi') ? '/xiaozhi' : '';
    if ((p === '' || p === '/') && !/\/$/.test(String(req.originalUrl || ''))) return res.redirect(pre + '/firmware/');
    if (p === '/login' || p.startsWith('/api/login') || PUBLIC_APP_PATHS.test(p)) return next();
    if (!authEnabled(cfg)) { req.manageUser = 'anonymous'; return next(); }
    const user = tokenUser(cfg, req);
    if (user) { req.manageUser = user; return next(); }
    if (p.startsWith('/api/') || p.startsWith('/vendor/')) {
      return res.status(401).json({ error: 'login required' });
    }
    const target = String(req.originalUrl || '');
    return res.redirect(pre + '/firmware/login?redirect=' + encodeURIComponent(target));
  };
}

export function createStudioRouter(cfg, hooks = {}) {
  const router = express.Router();
  router.use(express.json());
  if (authEnabled(cfg)) ensureDefaultAdmin(cfg);

  router.get('/env', async (req, res, next) => { try { res.json(await probeEnv(cfg)); } catch (e) { next(e); } });
  router.get('/config', (req, res) => res.json(cfg));
  router.get('/boards', async (req, res, next) => { try { res.json(await listBoards(cfg, { refresh: req.query.refresh === '1' })); } catch (e) { next(e); } });
  router.get('/devices', async (req, res, next) => { try { res.json(await listDevices(cfg, Number(req.query.limit) || 10)); } catch (e) { next(e); } });
  router.get('/detect', async (req, res, next) => { try { res.json(await detectBoard(cfg)); } catch (e) { next(e); } });
  router.get('/releases', async (req, res, next) => { try { res.json(await checkOfficial(cfg, req.query.type)); } catch (e) { next(e); } });
  router.get('/firmware', (req, res) => { try { res.json(listInstalled(cfg)); } catch (e) { res.status(500).json({ error: e.message }); } });
  // Raw image download for the browser Web Serial flasher
  router.get('/firmware/download', (req, res) => {
    const f = String(req.query.file || '');
    if (!/^[A-Za-z0-9._\-]+$/.test(f)) return res.status(400).json({ error: 'bad filename' });
    const p = path.join(cfg.dataBinDir, f);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'not found' });
    res.download(p, f);
  });

  router.post('/login', (req, res) => {
    if (!authEnabled(cfg)) return res.json({ ok: true, note: 'auth disabled' });
    const guard = cfg.loginGuard || LOGIN_GUARD;
    const ip = clientIp(req);
    const state = guardCheck(ip, guard);
    if (state.blocked) {
      console.warn(`[LoginGuard] blocked attempt from locked IP ${ip} (retry in ${state.retryAfterSec}s)`);
      res.set('Retry-After', String(state.retryAfterSec));
      return res.status(429).json({ error: 'ログイン試行回数が多すぎます。このIPは一定時間ロックされています', errorZh: '登录尝试次数过多，该 IP 已被临时锁定', retryAfterSec: state.retryAfterSec });
    }
    const username = String((req.body && req.body.username) || '').trim();
    const pw = String((req.body && req.body.password) || '');
    if (!verifyUser(cfg, username, pw)) {
      const r = guardRecordFail(ip, guard);
      console.log(`[StudioAuth] login rejected for "${username}" from ${ip} (fail ${r.count}/${guard.maxFails})`);
      const msg = r.locked
        ? { error: 'ログイン失敗回数が上限に達しました。このIPはロックされました', errorZh: '登录失败次数已达上限，该 IP 已被锁定' }
        : { error: '用户名或密码错误' };
      if (r.locked) res.set('Retry-After', String(guard.lockMs / 1000));
      return res.status(r.locked ? 429 : 401).json(msg);
    }
    // Cookie Path must match the external namespace the browser is browsing (/xiaozhi on cloud)
    loginFails.delete(ip); // successful login clears the failure window
    const pre = String(req.originalUrl || '').startsWith('/xiaozhi') ? '/xiaozhi' : '';
    // Cookie Path is the namespace root so the session reaches both /firmware
    // and the public relay /api/homekit on the cloud hub (guard reads xzmanage).
    res.setHeader('Set-Cookie', `xzmanage=${makeToken(cfg, username)}; Path=${pre}/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    console.log(`[StudioAuth] login ok for "${username}" from ${ip}`);
    res.json({ ok: true, username });
  });
  router.post('/logout', (req, res) => {
    const pre = String(req.originalUrl || '').startsWith('/xiaozhi') ? '/xiaozhi' : '';
    res.setHeader('Set-Cookie', `xzmanage=; Path=${pre}/; HttpOnly; Max-Age=0`);
    res.json({ ok: true });
  });

  // ---- console accounts (admin users) ----
  router.get('/users', (req, res) => { res.json({ items: listUsers(cfg), me: req.manageUser }); });
  router.post('/users/add', (req, res) => {
    const r = addUser(cfg, { username: req.body && req.body.username, password: req.body && req.body.password, role: 'admin', by: req.manageUser });
    res.status(r.error ? 400 : 200).json(r);
  });
  router.post('/users/delete', (req, res) => {
    const r = deleteUser(cfg, String((req.body && req.body.username) || ''), req.manageUser);
    res.status(r.error ? 400 : 200).json(r);
  });
  router.post('/users/password', (req, res) => {
    const r = setPassword(cfg, String((req.body && req.body.username) || ''), (req.body && req.body.password), req.manageUser);
    res.status(r.error ? 400 : 200).json(r);
  });

  router.post('/build', (req, res) => {
    const { board, name, type, otaUrl, otaUrlFallback, wakeWord, flashSize } = req.body || {};
    try {
      res.json(startBuild(cfg, { board, name, type, otaUrl, otaUrlFallback, wakeWord, flashSize }));
    } catch (e) { res.status(500).json({ error: '编译启动失败: ' + e.message }); } // {jobId} or {error}
  });
  router.get('/builds', (req, res) => res.json({ items: listJobs() }));
  router.get('/build/:id', (req, res) => {
    const j = getJob(req.params.id);
    if (!j) return res.status(404).json({ error: 'job not found' });
    const { logs, ...rest } = j;
    res.json(rest);
  });

  router.get('/events', (req, res) => {
    sseHead(res);
    SSE.add(res);
    res.write('retry: 3000\n\n');
  });

  router.post('/install', async (req, res) => { try { res.json(await installFirmware(cfg, req.body || {})); } catch (e) { res.status(500).json({ error: e.message }); } });
  router.post('/firmware/delete', (req, res) => { try { res.json(removeFirmware(cfg, req.body || {})); } catch (e) { res.status(500).json({ error: e.message }); } });

  router.post('/sync', (req, res) => streamAction(res, (onLine) => syncSource(cfg, req.body || {}, onLine)));
  router.post('/flash', (req, res) => streamAction(res, (onLine) => flashUsb(cfg, req.body || {}, onLine)));
  
  // MasterPi connection settings (option A): SSH read/patch of the Pi's local
  // config.json server block + systemd restart. Raw results, same as other endpoints.
  router.get('/masterpi/config', (req, res) => { try { res.json(getConnection(cfg)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  router.get('/masterpi/status', (req, res) => { try { res.json(getServiceStatus(cfg)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  router.post('/masterpi/config', (req, res) => { try { res.json(setConnection(cfg, req.body || {})); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
  // Face-detection debug stream (on-demand MJPEG preview on the Pi)
  router.get('/masterpi/stream/status', (req, res) => { try { res.json(streamStatus(cfg)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  router.post('/masterpi/stream/start', (req, res) => { try { res.json(streamStart(cfg)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  router.post('/masterpi/stream/stop', (req, res) => { try { res.json(streamStop(cfg)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  // Face library (identity recognition): SSH face_db.py CLI; enroll goes via /api/mcp/call
  router.get('/masterpi/faces', (req, res) => { try { res.json(facesList(cfg)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  router.delete('/masterpi/faces', (req, res) => { try { res.json(facesDelete(cfg, req.query.name)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  router.post('/masterpi/faces/rename', (req, res) => { const b = req.body || {}; try { res.json(facesRename(cfg, b.key, b.id, b.name)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  router.post('/masterpi/faces/facelogin', (req, res) => { const b = req.body || {}; try { res.json(facesFaceLogin(cfg, b.on)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
  router.post('/masterpi/faces/threshold', (req, res) => { try { res.json(facesThreshold(cfg, (req.body || {}).value)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });

  // ---- 接口管理（externalSystems 注册表 + sharedToken + voiceFlow SSRF 白名单）----
  // 写入的是运行中服务器加载的同一份 config.json，保存后就地热重载（无需重启）。
  const interfacesConfigPath = () => hooks.configPath || path.join(path.dirname(cfg.manageDir || '.'), 'config.json');

  router.get('/interfaces', (req, res) => {
    try {
      const file = interfacesConfigPath();
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      res.json({
        ok: true,
        sharedToken: raw.sharedToken || '',
        voiceFlowCallbackAllowList: (raw.voiceFlow && raw.voiceFlow.callbackAllowList) || [],
        voiceFlowTokenRef: (raw.voiceFlow && raw.voiceFlow.token) || '',
        externalSystems: raw.externalSystems || {},
        capabilities: {
          inbound: Object.keys(INBOUND_CAPABILITIES),
          outbound: Object.keys(OUTBOUND_CAPABILITIES)
        }
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/interfaces/save', (req, res) => {
    const body = req.body || {};
    // ---- 写侧校验（fail-closed：未知/方向错的 capability 直接 400，不静默写坏注册表）----
    const systems = body.externalSystems;
    if (!systems || typeof systems !== 'object' || Array.isArray(systems)) {
      return res.status(400).json({ ok: false, error: 'externalSystems 必须为对象' });
    }
    for (const [name, s] of Object.entries(systems)) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return res.status(400).json({ ok: false, error: `系统 ${name} 必须为对象` });
      if (!/^[A-Za-z0-9_.\-]+$/.test(name)) return res.status(400).json({ ok: false, error: `系统名 ${name} 含非法字符` });
      for (const cap of s.inbound || []) {
        if (!isKnownCapability(cap)) return res.status(400).json({ ok: false, error: `${name}.inbound 未知能力 "${cap}"` });
        if (capabilityDirection(cap) !== 'inbound') return res.status(400).json({ ok: false, error: `${name}.inbound "${cap}" 非入站能力` });
      }
      for (const [cap, def] of Object.entries(s.outbound || {})) {
        if (!isKnownCapability(cap)) return res.status(400).json({ ok: false, error: `${name}.outbound 未知能力 "${cap}"` });
        if (capabilityDirection(cap) !== 'outbound') return res.status(400).json({ ok: false, error: `${name}.outbound "${cap}" 非出站能力` });
        if (def && typeof def !== 'object') return res.status(400).json({ ok: false, error: `${name}.outbound.${cap} 必须为对象` });
        if (s.enabled !== false && cap === 'employeeTurn' && !String(s.baseUrl || '').trim()) {
          return res.status(400).json({ ok: false, error: `${name} 声明 outbound.employeeTurn 但缺 baseUrl` });
        }
      }
    }
    const allowList = Array.isArray(body.voiceFlowCallbackAllowList)
      ? body.voiceFlowCallbackAllowList.map((x) => String(x).trim()).filter(Boolean)
      : null;
    if (!allowList) return res.status(400).json({ ok: false, error: 'voiceFlowCallbackAllowList 必须为数组' });

    try {
      const file = interfacesConfigPath();
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 只改接口相关键，其余段落原样保留（sharedToken 为引用源，voiceFlow.token 固定为 "$shared"）。
      raw.sharedToken = String(body.sharedToken == null ? '' : body.sharedToken).trim();
      raw.voiceFlow = Object.assign({}, raw.voiceFlow, { callbackAllowList: allowList });
      raw.externalSystems = systems;
      fs.writeFileSync(file + '.bak', JSON.stringify(raw, null, 2)); // 备份原文件
      fs.writeFileSync(file + '.tmp', JSON.stringify(raw, null, 2));
      fs.renameSync(file + '.tmp', file);
      let reloaded = null;
      if (typeof hooks.onInterfacesChanged === 'function') {
        try { reloaded = hooks.onInterfacesChanged(); }
        catch (e) { return res.status(500).json({ ok: false, error: '已写入但热重载失败（请手动重启）：' + e.message }); }
      }
      console.log(`[StudioInterfaces] saved: systems=${Object.keys(systems).join(',') || '(none)'}, allow=${allowList.length}${reloaded ? ', reloaded live' : ', restart to apply'}`);
      res.json({ ok: true, reloaded, note: reloaded ? null : '请重启服务以使配置生效' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
