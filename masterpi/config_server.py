#!/usr/bin/env python3
"""
MasterPi connection settings web page (option B: Pi-hosted editor).

Single source of truth is this device's local config.json `server` block
(primary + backup xiaozhi-server ws URLs). The studio console (option A) edits
the SAME file over SSH; both stay consistent because there is only one file.

Endpoints (stdlib http.server only, no new dependency):
  GET  /             -> settings HTML form
  GET  /api/config   -> read connection block (+ service status)
  POST /api/config   -> validate + atomically write server block; optional restart
  POST /api/restart  -> restart the masterpi-client service

Auth: if config.configServer.token is non-empty, /api/* require it (header
X-Config-Token or ?token=). Empty token = open local access (dev default).

Usage: python3 config_server.py --config config.json [--port 8010]
"""

import argparse
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [masterpi.config] %(message)s")
log = logging.getLogger("masterpi.config")

WS_URL_RE = re.compile(r"^(ws|wss)://[^\s]+$")


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def atomic_write_json(path, data):
    """Back up then write atomically (temp + os.replace). Preserves other keys."""
    if os.path.exists(path):
        shutil.copy2(path, path + ".bak")
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".config.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def validate_ws(url, allow_empty=False):
    if url is None:
        url = ""
    url = url.strip()
    if not url:
        if allow_empty:
            return ""
        raise ValueError("primary server URL is required")
    if not WS_URL_RE.match(url):
        raise ValueError(f"invalid ws/wss URL: {url}")
    return url


def restart_service(cfg):
    name = (cfg.get("server") or {}).get("clientService") or os.environ.get("MASTERPI_CLIENT_SERVICE", "masterpi-client")
    # Try passwordless sudo first (sudoers drop-in installed by install_pi_service.sh),
    # then plain systemctl (works if this process is privileged).
    for cmd in (["sudo", "-n", "systemctl", "restart", name], ["systemctl", "restart", name]):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        except Exception as e:
            log.warning("restart via %s failed to launch: %s", cmd[0], e)
            continue
        if r.returncode == 0:
            log.info("service %s restarted", name)
            return {"ok": True, "service": name}
        log.warning("restart via %s rc=%s stderr=%s", cmd[0], r.returncode, (r.stderr or "").strip())
    return {"ok": False, "service": name, "error": f"could not restart {name}; open the page served by systemd or run: systemctl restart {name}"}


def service_status():
    name = os.environ.get("MASTERPI_CLIENT_SERVICE", "masterpi-client")
    try:
        r = subprocess.run(["systemctl", "is-active", name], capture_output=True, text=True, timeout=10)
        return (r.stdout or "").strip() or "unknown"
    except Exception as e:
        log.warning("is-active check failed: %s", e)
        return "unknown"


class Handler(BaseHTTPRequestHandler):
    config_path = "config.json"

    def _cfg(self):
        return load_json(self.config_path)

    def _authorized(self):
        token = ((self._cfg().get("configServer") or {}).get("token")) or ""
        if not token:
            return True  # open local access
        got = self.headers.get("X-Config-Token") or ""
        if not got:
            qs = self.path.split("?", 1)
            if len(qs) == 2:
                for kv in qs[1].split("&"):
                    if kv.startswith("token="):
                        got = kv[len("token="):]
        return got == token

    def _send(self, code, body, ctype="application/json"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except json.JSONDecodeError:
            return None

    def log_message(self, fmt, *a):
        log.info("%s - %s", self.address_string(), fmt % a)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            return self._send(200, INDEX_HTML, "text/html")
        if path == "/api/config":
            if not self._authorized():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            cfg = self._cfg()
            srv = cfg.get("server") or {}
            return self._send(200, {
                "ok": True,
                "primary": srv.get("primary") or cfg.get("wsUrl") or "",
                "backup": srv.get("backup") or "",
                "deviceName": cfg.get("deviceName", "MasterPi"),
                "deviceId": cfg.get("deviceId", ""),
                "tokenRequired": bool((cfg.get("configServer") or {}).get("token")),
                "serviceStatus": service_status(),
            })
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/api/config", "/api/restart"):
            return self._send(404, {"ok": False, "error": "not found"})
        if not self._authorized():
            return self._send(401, {"ok": False, "error": "unauthorized"})
        body = self._read_body()
        if body is None:
            return self._send(400, {"ok": False, "error": "invalid JSON body"})
        if path == "/api/restart":
            return self._send(200, restart_service(self._cfg()))
        # /api/config
        try:
            primary = validate_ws(body.get("primary"), allow_empty=False)
            backup = validate_ws(body.get("backup"), allow_empty=True)
        except ValueError as e:
            return self._send(400, {"ok": False, "error": str(e)})
        cfg = self._cfg()
        srv = cfg.get("server") or {}
        srv["primary"] = primary
        srv["backup"] = backup
        cfg["server"] = srv
        # keep legacy wsUrl in sync with primary for tools that still read it
        if "wsUrl" in cfg:
            cfg["wsUrl"] = primary
        name = body.get("deviceName")
        if isinstance(name, str) and name.strip():
            cfg["deviceName"] = name.strip()
        atomic_write_json(self.config_path, cfg)
        log.info("config updated: primary=%s backup=%s", primary, backup or "(none)")
        result = {"ok": True, "primary": primary, "backup": backup}
        if body.get("restart"):
            result["restart"] = restart_service(cfg)
        return self._send(200, result)


INDEX_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MasterPi Connection Settings</title>
<style>
 body{font-family:system-ui,-apple-system,Arial;margin:0;background:#0f1420;color:#e8edf6}
 .wrap{max-width:560px;margin:40px auto;padding:24px;background:#171d2c;border-radius:12px;box-shadow:0 4px 20px #0006}
 h1{font-size:18px;margin:0 0 4px} .sub{color:#8a94a8;font-size:12px;margin-bottom:20px}
 label{display:block;font-size:13px;margin:16px 0 6px;color:#aeb8cc}
 input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid #2c3752;background:#0f1524;color:#e8edf6;font-size:14px}
 .row{display:flex;gap:12px;margin-top:22px}
 button{flex:1;padding:10px;border:0;border-radius:8px;font-size:14px;cursor:pointer}
 .save{background:#2f6fed;color:#fff} .rst{background:#243456;color:#cfe0ff}
 .hint{font-size:12px;color:#7f8aa0;margin-top:6px}
 .msg{margin-top:16px;font-size:13px;min-height:18px}
 .ok{color:#39d98a} .err{color:#ff6b6b}
 .st{display:inline-block;padding:2px 8px;border-radius:6px;font-size:12px;background:#243456;color:#cfe0ff;margin-left:8px}
</style></head><body><div class="wrap">
 <h1>MasterPi Connection Settings<span id="st" class="st"></span></h1>
 <div class="sub">Primary server is tried first; on repeated failures it fails over to Backup (one-way, no switch-back until restart).</div>
 <div id="tokenBox"><label>Access Token</label><input id="token" type="password" placeholder="leave empty if not required"></div>
 <label>Primary server (ws:// or wss://)</label>
 <input id="primary" placeholder="ws://192.168.1.55:8003/xiaozhi/v1/">
 <label>Backup server (optional)</label>
 <input id="backup" placeholder="wss://cloud-host:8003/xiaozhi/v1/  (empty = disabled)">
 <label>Device name</label>
 <input id="deviceName">
 <div class="row"><button class="save" onclick="saveCfg(true)">Save &amp; Restart</button>
 <button class="rst" onclick="saveCfg(false)">Save only</button></div>
 <div class="hint">Writes to this device's local config.json (server block). Robot safety fields (allowChassis=false) are untouched.</div>
 <div id="msg" class="msg"></div>
</div>
<script>
 function apiTok(){return document.getElementById('token').value||'';}
 async function load(){
   try{
     const r=await fetch('/api/config',{headers:{'X-Config-Token':apiTok()}});
     const j=await r.json();
     if(!j.ok){if(r.status===401){show('Token required','err');}return;}
     document.getElementById('primary').value=j.primary||'';
     document.getElementById('backup').value=j.backup||'';
     document.getElementById('deviceName').value=j.deviceName||'';
     document.getElementById('st').textContent='service: '+(j.serviceStatus||'?');
     if(!j.tokenRequired)document.getElementById('tokenBox').style.display='none';
   }catch(e){show('load failed: '+e,'err');}
 }
 async function saveCfg(restart){
   const body={primary:document.getElementById('primary').value.trim(),
               backup:document.getElementById('backup').value.trim(),
               deviceName:document.getElementById('deviceName').value.trim(),restart:restart};
   try{
     const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json','X-Config-Token':apiTok()},body:JSON.stringify(body)});
     const j=await r.json();
     if(j.ok){show('saved'+(restart?(' & '+(j.restart&&j.restart.ok?'restarted':'restart failed')):''),'ok');load();}
     else show(j.error||'save failed','err');
   }catch(e){show('save failed: '+e,'err');}
 }
 function show(t,c){const m=document.getElementById('msg');m.textContent=t;m.className='msg '+(c||'');}
 document.getElementById('token').addEventListener('change',load);
 load();
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    Handler.config_path = args.config
    cfg = load_json(args.config)
    port = args.port or int((cfg.get("configServer") or {}).get("port") or 8010)
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    log.info("config server listening on 0.0.0.0:%d (config=%s)", port, args.config)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log.info("interrupted")


if __name__ == "__main__":
    sys.exit(main())
