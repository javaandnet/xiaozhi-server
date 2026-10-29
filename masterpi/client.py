#!/usr/bin/env python3
"""
MasterPi xiaozhi-server 接入客户端(路线 A:哑设备,只走 MCP,不收发音频)。

协议对齐 xiaozhi-server 的 device-MCP 模型(见 core/services/mcp.js):
  server --{type:mcp, method:initialize}-->  device  回 {id:1, result:{serverInfo}}
  server --{type:mcp, method:tools/list}-->  device  回 {id:2, result:{tools:[...]}}
  server --{type:mcp, method:tools/call}--> device  回 {id:N, result:{content:[...]}}

用法:
  python3 client.py --config config.example.json
"""

import argparse
import asyncio
import json
import logging

import websockets

from robot import Robot
from tools import TOOLS, build_dispatcher

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
log = logging.getLogger("masterpi.client")


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_server_list(cfg):
    """Ordered candidate servers: prefer new `server` block, fall back to legacy top-level `wsUrl`.
    Returns [primary, backup] (empty entries filtered). Never empty (raises otherwise)."""
    srv = cfg.get("server") or {}
    servers = [srv.get("primary"), srv.get("backup")]
    servers = [s for s in servers if s]
    if not servers and cfg.get("wsUrl"):
        servers = [cfg["wsUrl"]]
    if not servers:
        raise ValueError("no server configured: set server.primary/backup or legacy wsUrl")
    return servers


# Reconnect policy: connect failures (or fast flapping) toward the SAME slot advance
# one-way to the next slot; a stable session resets the counter. No auto-switch-back
# to primary until the process is restarted (systemd restart / boot).
CONNECT_RETRY = 5
BACKOFF_START = 2
BACKOFF_MAX = 30
MIN_STABLE_SEC = 20
# 僵尸连接看门狗：TCP 半死(对端换进程但未回 RST)时库层 keepalive 可能无感，
# 定期主动发 WS ping 并要求限时 pong，超时即判僵尸、主动断开触发 supervisor 重连。
ZOMBIE_PING_SEC = 45
ZOMBIE_PONG_TIMEOUT_SEC = 15


class MasterPiClient:
    def __init__(self, cfg):
        self.cfg = cfg
        self.robot = Robot(cfg)
        self.dispatch = build_dispatcher(self.robot)
        self.session_id = None
        self.servers = build_server_list(cfg)

    async def _send_json(self, ws, obj):
        await ws.send(json.dumps(obj, ensure_ascii=False))

    async def _send_hello(self, ws):
        hello = {
            "type": "hello",
            "version": 1,
            "transport": "websocket",
            "device_id": self.cfg.get("deviceId"),
            "device_name": self.cfg.get("deviceName", "MasterPi"),
            "device_mac": self.cfg.get("deviceMac"),
            # 声明为机器人外设（非小智语音设备）：server 不会把它登记进设备一览，
            # 但仍按 device-MCP 客户端采集其工具。可用 config.deviceType 覆盖。
            "device_type": self.cfg.get("deviceType", "robot"),
            # 关键:声明 mcp 能力,server 才会下发 initialize
            "features": {"mcp": True},
        }
        await self._send_json(ws, hello)
        log.info("hello sent, waiting for server handshake")

    async def _handle_mcp(self, ws, payload):
        method = payload.get("method")
        pid = payload.get("id")
        if method == "initialize":
            await self._send_json(ws, {
                "type": "mcp",
                "payload": {
                    "jsonrpc": "2.0",
                    "id": pid,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "MasterPi", "version": "0.1.0"},
                    },
                },
            })
            log.info("responded initialize (tools=%d)", len(TOOLS))
        elif method == "tools/list":
            await self._send_json(ws, {
                "type": "mcp",
                "payload": {"jsonrpc": "2.0", "id": pid, "result": {"tools": TOOLS}},
            })
            log.info("responded tools/list with %d tools", len(TOOLS))
        elif method == "tools/call":
            params = payload.get("params", {}) or {}
            name = params.get("name", "")
            args = params.get("arguments", {}) or {}
            fn = self.dispatch.get(name)
            if fn is None:
                result_payload = {"content": [{"type": "text", "text": f"tool not found: {name}"}], "isError": True}
            else:
                try:
                    # 工具可能长耗时(如人脸搜寻扫描≈20s),在工作线程执行,
                    # 避免阻塞事件循环导致 ping/pong 超时断连。
                    loop = asyncio.get_running_loop()
                    res = await loop.run_in_executor(None, fn, args)
                    result_payload = {"content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False)}], "isError": False}
                    # 感知类事件上报:人脸搜寻命中后,主动上报 face_found,
                    # 由 server 统一调度播报(端侧不自行合成/播报)。
                    if name == "robot.search_face" and isinstance(res, dict) and res.get("found"):
                        await self._send_json(ws, {
                            "type": "mcp",
                            "payload": {
                                "jsonrpc": "2.0",
                                "method": "robot.face_found",
                                "params": {
                                    "provider": self.cfg.get("deviceId"),
                                    "pose": res.get("pose"),
                                    "centered": res.get("centered"),
                                    "person": res.get("person"),
                                    "person_id": res.get("person_id"),
                                },
                            },
                        })
                        log.info("reported robot.face_found pose=%s centered=%s person=%s id=%s",
                                 res.get("pose"), res.get("centered"),
                                 res.get("person"), res.get("person_id"))
                except Exception as e:  # 补日志,不静默吞异常
                    log.exception("tool %s execution failed", name)
                    result_payload = {"content": [{"type": "text", "text": f"error: {e}"}], "isError": True}
            await self._send_json(ws, {"type": "mcp", "payload": {"jsonrpc": "2.0", "id": pid, "result": result_payload}})
            log.info("responded tools/call name=%s", name)
        else:
            log.info("ignore mcp method=%s", method)

    async def _zombie_watchdog(self, ws, url):
        """App-level watchdog against half-dead TCP: active ping with bounded pong.
        On timeout treat the session as zombie, close it and let the supervisor reconnect."""
        while True:
            await asyncio.sleep(ZOMBIE_PING_SEC)
            try:
                pong = await ws.ping()
                await asyncio.wait_for(pong, timeout=ZOMBIE_PONG_TIMEOUT_SEC)
            except Exception as e:  # log and force reconnect, never swallow silently
                log.warning("zombie watchdog: %s dead (%s), forcing reconnect", url, e)
                try:
                    await ws.close()
                except Exception as ce:  # best-effort
                    log.debug("watchdog close ignored: %s", ce)
                return

    async def _run_once(self, url):
        """Connect to one server and run the message loop until it ends.
        Returns (established, duration_sec): established=True once the WS is open
        (even if it later drops), False if it could not connect at all."""
        # device-id / client-id are carried in the hello payload; HTTP headers are optional.
        # Do not pass additional_headers/extra_headers to stay compatible across websockets API.
        try:
            ws = await websockets.connect(url, ping_interval=30, ping_timeout=20)
        except (OSError, websockets.WebSocketException) as e:
            log.warning("connect to %s failed: %s", url, e)
            return False, 0.0
        start = asyncio.get_event_loop().time()
        established = True
        watchdog = asyncio.create_task(self._zombie_watchdog(ws, url))
        try:
            await self._send_hello(ws)
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    # binary audio frames: this is a dumb device client, ignore
                    continue
                mtype = msg.get("type")
                if mtype == "hello":
                    self.session_id = msg.get("session_id")
                    log.info("server hello ok session_id=%s", self.session_id)
                elif mtype == "mcp":
                    await self._handle_mcp(ws, msg.get("payload", {}) or {})
                # other types (TTS/LSTN/stt...) are irrelevant for a dumb device
        except asyncio.CancelledError:
            watchdog.cancel()
            raise
        except Exception as e:  # connection dropped mid-session
            log.warning("session on %s dropped: %s", url, e)
        finally:
            watchdog.cancel()
            try:
                await ws.close()
            except Exception as e:  # best-effort close
                log.debug("ws close ignored: %s", e)
        return established, asyncio.get_event_loop().time() - start

    async def run(self):
        """Never-exiting supervisor: auto-reconnect + one-way primary->backup failover."""
        index = 0
        n = len(self.servers)
        fail_in_row = 0
        backoff = BACKOFF_START
        while True:
            url = self.servers[index]
            log.info("connecting to %s (server %d/%d)", url, index + 1, n)
            established, dur = await self._run_once(url)
            healthy = established and dur >= MIN_STABLE_SEC
            if healthy:
                fail_in_row = 0
                backoff = BACKOFF_START
            else:
                fail_in_row += 1
                if fail_in_row >= CONNECT_RETRY and index < n - 1:
                    index += 1
                    fail_in_row = 0
                    log.warning("failover to next server %s (one-way, no switch-back until restart)", self.servers[index])
            delay = min(backoff, BACKOFF_MAX)
            log.info("reconnect to %s in %ds", self.servers[index], delay)
            await asyncio.sleep(delay)
            backoff = min(backoff * 2, BACKOFF_MAX)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.example.json")
    args = ap.parse_args()
    cfg = load_config(args.config)
    client = MasterPiClient(cfg)
    log.info("server list: %s", client.servers)
    try:
        asyncio.run(client.run())
    except KeyboardInterrupt:
        log.info("interrupted")


if __name__ == "__main__":
    main()
