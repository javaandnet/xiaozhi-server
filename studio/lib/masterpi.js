// MasterPi connection management (studio option A): SSH into the Pi via the
// existing masterpi/scripts/pish.sh (reuses its SSH_ASKPASS password mechanism,
// so no password is written here) to read/patch the "server" block of the Pi's
// local ~/masterpi_client/config.json and restart the systemd client service.
//
// The Pi's local config.json stays the single source of truth; the client reads
// it on every (re)connect, so a restart makes server changes take effect at once.

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PISH = path.join(__dirname, '..', '..', 'masterpi', 'scripts', 'pish.sh');

// ws/wss URL allowlist (mirror of config_server.py validate_ws)
const WS_URL_RE = /^wss?:\/\/[A-Za-z0-9.\-_]+(:\d+)?(\/[^\s]*)?$/;

function validateWs(label, v) {
  const s = (v == null ? '' : String(v)).trim();
  if (!s) return '';
  if (!WS_URL_RE.test(s)) throw new Error(`${label}: not a valid ws:// or wss:// url`);
  return s;
}

export function target(cfg) {
  const m = cfg.masterpi || (cfg.firmware && cfg.firmware.masterpi) || {};
  return {
    host: m.host || '192.168.1.91',
    user: m.user || 'pi',
    remoteConfig: m.remoteConfig || '~/masterpi_client/config.json',
    clientService: m.clientService || 'masterpi-client',
    configPort: Number(m.configPort) || 8010,
    streamPort: Number(m.streamPort) || 8110,
    streamScript: m.streamScript || 'vision_stream.py',
    streamDir: m.streamDir || '~/masterpi_client',
  };
}

// Run a remote command on the Pi through pish.sh; returns {ok, stdout, stderr, code}
// pish.sh multiplexes over a shared ControlPath socket, so repeated calls reuse
// one connection. ssh returns 255 only for transport-level failures (unreachable,
// broken/stale master, connection reset) — not for a legitimate non-zero remote
// exit — so that is the sole case worth a single retry (recovers a dead mux).
function runPi(t, remoteCmd, timeoutMs = 25000) {
  let r = piAttempt(t, remoteCmd, timeoutMs);
  if (r.code === 255) r = { ...piAttempt(t, remoteCmd, timeoutMs), retried: true };
  return r;
}

function piAttempt(t, remoteCmd, timeoutMs) {
  const r = spawnSync('bash', [PISH, 'run', remoteCmd], {
    env: { ...process.env, PI_HOST: t.host, PI_USER: t.user },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  if (r.error) return { ok: false, stdout, stderr: String(r.error.message), code: -1 };
  return { ok: r.status === 0, stdout, stderr, code: r.status == null ? -1 : r.status };
}

// Read the Pi's server config (never returns the ssh password).
export function getConnection(cfg) {
  const t = target(cfg);
  const r = runPi(t, `cat ${t.remoteConfig} 2>/dev/null`);
  if (!r.ok || !r.stdout) {
    return { ok: false, error: r.stderr || `cannot read ${t.remoteConfig} on ${t.host}`, target: { host: t.host, user: t.user } };
  }
  let j;
  try { j = JSON.parse(r.stdout); } catch (e) { return { ok: false, error: `remote config is not valid JSON: ${e.message}` }; }
  const srv = j.server || {};
  return {
    ok: true,
    target: { host: t.host, user: t.user, configPort: t.configPort, configPageUrl: `http://${t.host}:${t.configPort}/` },
    primary: srv.primary || j.wsUrl || '',
    backup: srv.backup || '',
    deviceName: j.deviceName || '',
    deviceId: j.deviceId || '',
    serverCount: [srv.primary, srv.backup].filter(Boolean).length,
  };
}

// Service state on the Pi (best-effort; empty when systemctl unavailable).
export function getServiceStatus(cfg) {
  const t = target(cfg);
  const r = runPi(t, `systemctl is-active ${t.clientService} 2>/dev/null; systemctl is-enabled ${t.clientService} 2>/dev/null`, 12000);
  const lines = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return { active: lines[0] || 'unknown', enabled: lines[1] || 'unknown' };
}

// Remote-restart the device-MCP client service on the Pi (zombie-session recovery:
// after a server restart the Pi may hold a half-dead TCP that never re-registers).
export function restartClient(cfg) {
  const t = target(cfg);
  const r = runPi(t, `sudo systemctl restart ${t.clientService} && sleep 2 && systemctl is-active ${t.clientService}`, 45000);
  const active = (r.stdout || '').trim();
  return r.ok
    ? { ok: true, active }
    : { ok: false, active, error: r.stderr || r.stdout || 'restart failed' };
}

// Graceful power-off (shutdown -h): safer than pulling the plug — the Pi keeps
// a face DB / event files on the SD card and hard cuts risk filesystem damage.
// The command is backgrounded on the Pi so this SSH session returns cleanly
// before the box goes down.
export function shutdownPi(cfg) {
  const t = target(cfg);
  const r = runPi(t, 'nohup sudo -n shutdown -h now >/dev/null 2>&1 & echo SHUTDOWN_ARMED', 15000);
  if (!r.ok || !/SHUTDOWN_ARMED/.test(r.stdout)) {
    return { ok: false, error: r.stderr || r.stdout || 'shutdown command failed' };
  }
  return { ok: true, host: t.host };
}

// Patch server.primary/backup (+ optional deviceName) on the Pi; restart service when asked.
// Payload goes to the Pi base64-encoded so shell quoting is a non-issue; the Python
// writer preserves all other keys (robot.*, etc.) and keeps a .bak.
export function setConnection(cfg, payload = {}) {
  const t = target(cfg);
  const primary = validateWs('primary', payload.primary);
  const backup = validateWs('backup', payload.backup);
  const deviceName = (payload.deviceName == null ? '' : String(payload.deviceName)).trim();
  const restart = payload.restart !== false; // default: restart

  const data = { primary, backup };
  if (deviceName) data.deviceName = deviceName;

  const py = [
    'import json,os,shutil,tempfile',
    `path=os.path.expanduser(${JSON.stringify(t.remoteConfig)})`,
    `NEW=${JSON.stringify(data)}`,
    'cfg=json.load(open(path,encoding="utf-8"))',
    'srv=cfg.get("server") or {}',
    'srv["primary"]=NEW.get("primary","")',
    'srv["backup"]=NEW.get("backup","")',
    'cfg["server"]=srv',
    'if NEW.get("deviceName"): cfg["deviceName"]=NEW["deviceName"]',
    'if "wsUrl" in cfg: cfg["wsUrl"]=NEW.get("primary","")',
    'if os.path.exists(path): shutil.copy2(path, path+".bak")',
    'd=os.path.dirname(os.path.abspath(path))',
    'fd,tn=tempfile.mkstemp(dir=d,prefix=".config.",suffix=".tmp")',
    'f=os.fdopen(fd,"w",encoding="utf-8")',
    'json.dump(cfg,f,ensure_ascii=False,indent=2); f.write("\\n"); f.close()',
    'os.replace(tn,path)',
    'print("WROTE "+path)',
  ].join('\n');

  const b64 = Buffer.from(py, 'utf8').toString('base64');
  const w = runPi(t, `printf %s '${b64}' | base64 -d | python3 -`);
  if (!w.ok) return { ok: false, step: 'write', error: w.stderr || w.stdout || 'remote write failed' };

  let restarted = false;
  let restartError = null;
  if (restart) {
    const rr = runPi(t, `sudo -n systemctl restart ${t.clientService} 2>&1 || systemctl restart ${t.clientService} 2>&1`, 20000);
    restarted = rr.ok;
    if (!rr.ok) restartError = rr.stderr || rr.stdout || 'restart failed';
  }
  const status = restarted ? getServiceStatus(cfg) : { active: 'unknown', enabled: 'unknown' };
  return {
    ok: restarted || !restart,
    wrote: true,
    restarted,
    restartError,
    status,
    target: { host: t.host, user: t.user },
    applied: data,
  };
}

// ---- Face-detection debug stream (vision_stream.py) on the Pi ----
// On-demand MJPEG preview. The stream becomes the single camera holder and also
// serves detections (/frames); search_face and face enroll borrow from it, so the
// preview and those tools now coexist on one camera. If the preview is stopped,
// the tools fall back to opening the local camera themselves.
function streamInfo(t, running) {
  return { running, port: t.streamPort, url: `http://${t.host}:${t.streamPort}/` };
}

// Read the live stream's /meta from the Pi (curl over SSH, JSON out).
function streamMeta(t) {
  const r = runPi(t, `curl -s -m 4 http://127.0.0.1:${t.streamPort}/meta 2>/dev/null`, 12000);
  if (!r.ok || !r.stdout) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

export function streamStatus(cfg) {
  const t = target(cfg);
  const r = runPi(t, `pgrep -f '[v]ision_stream' >/dev/null && echo RUN || echo STOP`, 12000);
  const running = /RUN/.test(r.stdout || '');
  const meta = running ? streamMeta(t) : null;
  // status passes through the stream's own health text: "ok" or e.g. "no frame (retrying)"
  // when the camera handle is dead, so the UI can offer a manual reconnect.
  return { ...streamInfo(t, running), mode: meta?.mode || '', faces: meta?.faces, changed: meta?.changed, status: meta?.status || '' };
}

const STREAM_MODES = ['face', 'preview', 'watch'];

export function streamStart(cfg, mode) {
  const t = target(cfg);
  const m = STREAM_MODES.includes(mode) ? mode : 'face';
  const chk = runPi(t, `pgrep -f '[v]ision_stream' >/dev/null && echo RUN || echo STOP`, 12000);
  if (/RUN/.test(chk.stdout || '')) {
    // already up: honor the requested mode rather than ignoring it
    runPi(t, `curl -s -m 4 -X POST "http://127.0.0.1:${t.streamPort}/mode?set=${m}" >/dev/null 2>&1`, 12000);
    return { ok: true, already: true, mode: m, ...streamInfo(t, true) };
  }
  const cmd = `cd ${t.streamDir} && test -f ${t.streamScript} && (setsid python3 ${t.streamScript} --port ${t.streamPort} --mode ${m} >/tmp/vstream.log 2>&1 </dev/null & echo LAUNCH_OK) || echo NO_SCRIPT`;
  const r = runPi(t, cmd, 15000);
  if (/NO_SCRIPT/.test(r.stdout || '')) return { ok: false, error: `${t.streamScript} not found on ${t.host}:${t.streamDir}` };
  // give the worker a moment to open the camera, then confirm it stayed up
  const after = runPi(t, `sleep 2; pgrep -f '[v]ision_stream' >/dev/null && echo RUN || echo STOP`, 12000);
  const running = /RUN/.test(after.stdout || '');
  return { ok: running, mode: m, error: running ? null : (r.stderr || r.stdout || 'launch failed'), ...streamInfo(t, running) };
}

export function streamSetMode(cfg, mode) {
  const t = target(cfg);
  if (!STREAM_MODES.includes(mode)) return { ok: false, error: `mode must be one of ${STREAM_MODES.join('/')}` };
  const up = runPi(t, `pgrep -f '[v]ision_stream' >/dev/null && echo RUN || echo STOP`, 12000);
  if (!/RUN/.test(up.stdout || '')) return { ok: false, error: 'stream not running' };
  const r = runPi(t, `curl -s -m 5 -X POST "http://127.0.0.1:${t.streamPort}/mode?set=${mode}" 2>/dev/null`, 12000);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* fall through */ }
  if (!r.ok || !parsed) return { ok: false, error: r.stderr || 'mode set failed' };
  return { ok: true, mode: parsed.mode || mode };
}

export function watchEvents(cfg, since = 0) {
  const t = target(cfg);
  const s = String(Number(since) || 0);
  const r = runPi(t, `curl -s -m 5 "http://127.0.0.1:${t.streamPort}/watch/events?since=${s}" 2>/dev/null`, 12000);
  if (!r.ok || !r.stdout) return { ok: false, error: r.stderr || 'no data', events: [] };
  try {
    const ev = JSON.parse(r.stdout);
    return { ok: true, events: Array.isArray(ev) ? ev : [] };
  } catch (e) { return { ok: false, error: `bad json: ${e.message}`, events: [] }; }
}

// Snapshot bytes come back over an utf8 channel, so fetch base64 on the Pi and decode here.
export function watchShot(cfg, name) {
  const t = target(cfg);
  const safe = String(name || '').replace(/[^0-9A-Za-z_.]/g, '');
  if (!safe) return { ok: false, error: 'bad shot name' };
  const r = runPi(t, `curl -s -m 8 "http://127.0.0.1:${t.streamPort}/watch/shot?name=${encodeURIComponent(safe)}" 2>/dev/null | base64 -w0`, 15000);
  if (!r.ok || !r.stdout) return { ok: false, error: r.stderr || 'shot not found' };
  const buf = Buffer.from(r.stdout.trim(), 'base64');
  if (!buf.length || buf[0] !== 0xff) return { ok: false, error: 'not a jpeg' };
  return { ok: true, jpeg: buf };
}

export function streamStop(cfg) {
  const t = target(cfg);
  runPi(t, `pkill -f '[v]ision_stream' ; sleep 1`, 12000);
  const after = runPi(t, `pgrep -f '[v]ision_stream' >/dev/null && echo RUN || echo STOP`, 12000);
  const running = /RUN/.test(after.stdout || '');
  return { ok: !running, ...streamInfo(t, running) };
}

// ---- Robot safety switch (robot.allowChassis in the Pi's local config.json) ----
// robot.py reads it once at startup and hard-refuses drive() unless true, so a
// write must restart masterpi-client to take effect. Default is false (locked).
export function getSafety(cfg) {
  const t = target(cfg);
  const r = runPi(t, `cat ${t.remoteConfig} 2>/dev/null`);
  if (!r.ok || !r.stdout) return { ok: false, error: r.stderr || `cannot read ${t.remoteConfig} on ${t.host}` };
  let j;
  try { j = JSON.parse(r.stdout); } catch (e) { return { ok: false, error: `remote config is not valid JSON: ${e.message}` }; }
  return { ok: true, allowChassis: !!(j.robot && j.robot.allowChassis === true) };
}

export function setSafety(cfg, allowChassis) {
  const t = target(cfg);
  const allow = allowChassis === true; // default-deny: anything but literal true locks
  const py = [
    'import json,os,shutil,tempfile',
    `path=os.path.expanduser(${JSON.stringify(t.remoteConfig)})`,
    'cfg=json.load(open(path,encoding="utf-8"))',
    'rb=cfg.get("robot") or {}',
    allow ? 'rb["allowChassis"]=True' : 'rb["allowChassis"]=False',
    'cfg["robot"]=rb',
    'if os.path.exists(path): shutil.copy2(path, path+".bak")',
    'd=os.path.dirname(os.path.abspath(path))',
    'fd,tn=tempfile.mkstemp(dir=d,prefix=".config.",suffix=".tmp")',
    'f=os.fdopen(fd,"w",encoding="utf-8")',
    'json.dump(cfg,f,ensure_ascii=False,indent=2); f.write("\\n"); f.close()',
    'os.replace(tn,path)',
    'print("WROTE "+str(rb["allowChassis"]))',
  ].join('\n');
  const b64 = Buffer.from(py, 'utf8').toString('base64');
  const w = runPi(t, `printf %s '${b64}' | base64 -d | python3 -`);
  if (!w.ok) return { ok: false, step: 'write', error: w.stderr || w.stdout || 'remote write failed' };
  // robot.py caches the flag at startup → restart the client so it re-reads config
  const rr = runPi(t, `sudo -n systemctl restart ${t.clientService} 2>&1 || systemctl restart ${t.clientService} 2>&1`, 20000);
  return {
    ok: rr.ok,
    allowChassis: allow,
    restarted: rr.ok,
    restartError: rr.ok ? null : (rr.stderr || rr.stdout || 'restart failed'),
    status: rr.ok ? getServiceStatus(cfg) : { active: 'unknown', enabled: 'unknown' },
  };
}

// ---- Face library (face_db.py on the Pi, identity recognition) ----
// list/delete/threshold go through the SSH CLI (pure JSON, no camera/servos);
// enrolling a face itself is an MCP tool call (robot_face_enroll) made by the
// frontend through the main server's /api/mcp/call, not here.
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function facesCli(t, args) {
  const r = runPi(t, `cd ${t.streamDir} && python3 face_db.py ${args}`, 20000);
  if (!r.ok) return { ok: false, error: r.stderr || r.stdout || 'face_db cli failed' };
  const line = ((r.stdout || '').split('\n').filter(Boolean).pop() || '').trim();
  try { return { ok: true, ...JSON.parse(line) }; } catch (e) { return { ok: false, error: `bad cli json: ${line}` }; }
}

export function facesList(cfg) {
  return facesCli(target(cfg), 'list');
}

export function facesDelete(cfg, name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: 'name required' };
  return facesCli(target(cfg), `delete ${shq(n)}`);
}

// Edit a member's id and/or display name (face_db rename, duplicate-checked).
// key locates the person by existing id or name.
export function facesRename(cfg, key, id, name) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'key required' };
  const ni = String(id || '').trim();
  const nn = String(name || '').trim();
  if (!ni && !nn) return { ok: false, error: 'id or name required' };
  if (ni && !/^p_[abcdefghjkmnpqrstuvwxyz23456789]{4,16}$/.test(ni)) {
    return { ok: false, error: 'bad id format (want p_[a-z2-9]{4,16}, no i/l/o/0/1)' };
  }
  const args = [`rename ${shq(k)}`];
  if (ni) args.push(`--id ${shq(ni)}`);
  if (nn) args.push(`--name ${shq(nn)}`);
  return facesCli(target(cfg), args.join(' '));
}

// Toggle the face-login feature switch (default off) on the Pi.
export function facesFaceLogin(cfg, on) {
  const t = target(cfg);
  if (on == null || on === '') return facesCli(t, 'facelogin');
  return facesCli(t, `facelogin ${on ? 'on' : 'off'}`);
}

export function facesThreshold(cfg, value) {
  const t = target(cfg);
  if (value == null || value === '') return facesCli(t, 'threshold');
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0.05 || v > 0.95) return { ok: false, error: 'threshold must be within 0.05~0.95' };
  return facesCli(t, `threshold ${v}`);
}
