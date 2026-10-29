#!/usr/bin/env python3
"""
人脸检测实时预览(调试用外接视频窗口) + 检测结果共享端点 + 三档相机模式。

模式(--mode, 运行时可 POST /mode?set= 切换):
- face    人脸识别:YuNet 检测(每 --det-every 帧一次,中间帧复用上帧框)+画框+嵌入,
          供 /frames 借帧;登记向导/search_face 依赖本模式(非 face 时调 /frames 会自动升级)。
- preview 普通预览:不检测不画框,纯转帧(最高 ~20fps,质量 70),看画面最流畅。
- watch   看家:~2fps 低频抓帧 + 灰度差帧变化检测(超阈占比>8%且过冷却即事件),
          命中存快照 watch_shots/ (滚动 20 张) + 事件环形 50 条持久化 watch_events.json。

用途:
1) 浏览器打开 http://<pi-ip>:8110/ 看摄像头实时画面,face 模式每帧叠加
   - 绿框:所有检出人脸;红框+黄点:目标(最大)脸
   - 画面中心十字线 + 中线
   - 顶部文字:检出数、目标脸归一化偏差 ex/ey(与 vision.CENTER_TOL 同口径)、帧尺寸
   检测统一走 DNN(YuNet),对印刷/卡通脸的误报远低于旧 Haar。
2) 供 masterpi_client 的 search_face/登记借"检测结果":GET /frames?n=k 返回"请求之后
   的接下来 k 帧"的人脸框 + 目标(最大)脸的 SFace 128 维嵌入(在干净帧上算,
   不含画框污染)。这样预览成为相机唯一持有者,search_face 不再自己开相机,
   两者共存共用一路相机,彻底消除抢占冲突。

设计约束:
- 绝不碰底盘轮子,也不动任何舵机:纯读相机 + 画框 + 报检测框。
- 相机独占:被占用时不崩,显示 "camera busy" 占位画面并持续重试。
- 复用 vision 的 _open_camera / make_face_detector / detect_faces_yunet,保证
  预览所见与 search_face 借到的检测完全同源。

用法(派上,按需):
  python3 vision_stream.py --port 8110 --camera auto [--width 640 --height 480] [--fps 12]
                           [--mode face|preview|watch] [--det-every 3] [--watch-cooldown 60]
"""

import argparse
import json
import logging
import os
import sys
import threading
import time
from collections import deque
from urllib.parse import urlparse, parse_qs

from vision import (_open_camera, CENTER_TOL, make_face_detector, detect_faces_yunet,
                    make_face_recognizer, embed_face)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
log = logging.getLogger("masterpi.vision_stream")

BOUNDARY = "masterpistream"
MODES = ("face", "preview", "watch")
# 各模式参数档:目标 fps / JPEG 质量(preview 降质量换流畅,B 项)
MODE_PARAMS = {"face": None, "preview": (20, 70), "watch": (2, 75)}


class StreamState:
    """后台取流线程:独占相机 + DNN 检测,维护环形帧缓冲供 /stream 与 /frames 共享。
    三档模式(face/preview/watch)运行时可切,参数见 MODE_PARAMS。"""

    def __init__(self, camera, width, height, fps, score, mode="face", det_every=3,
                 watch_cooldown=60.0, watch_ratio=0.08):
        self.camera = camera
        self.width = width
        self.height = height
        self.fps = max(1, min(fps, 30))
        self.score = score
        self._cond = threading.Condition()
        self._ring = deque(maxlen=30)   # 每条: {"seq","fw","fh","boxes","jpeg","meta"}
        self._seq = 0
        self._status = "starting"
        self._stop = threading.Event()
        self._thread = None
        self._mode = mode if mode in MODES else "face"
        self._det_every = max(1, int(det_every))  # A: face 模式每 N 帧检测一次
        self._last_faces = []                      # 中间帧复用上帧框
        # ---- 看家(watch)状态:差帧变化检测 + 事件/快照滚动 ----
        self._watch_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watch_shots")
        self._watch_events_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watch_events.json")
        self._watch_ref = None
        self._watch_ratio = watch_ratio
        self._watch_cooldown = watch_cooldown
        self._last_event_at = 0.0
        self._last_changed = False
        self._events = self._load_events()

    # ---- lifecycle ----
    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    # ---- mode ----
    @property
    def mode(self):
        with self._cond:
            return self._mode

    def set_mode(self, mode):
        if mode not in MODES:
            return False
        with self._cond:
            changed = mode != self._mode
            self._mode = mode
            self._last_faces = []
            self._watch_ref = None  # 切模式重置差帧参考,避免瞬间误报
            if changed:
                log.info("camera mode -> %s", mode)
            return True

    def _mode_params(self):
        """返回 (目标 fps, JPEG 质量);face 档沿用 CLI 值。"""
        return MODE_PARAMS.get(self._mode) or (self.fps, 80)

    # ---- watch events ----
    def _load_events(self):
        try:
            with open(self._watch_events_path, "r", encoding="utf-8") as f:
                ev = json.load(f)
            return ev if isinstance(ev, list) else []
        except Exception:
            return []

    def _record_event(self, cv2, frame, ratio):
        """变化事件:存快照(滚动 20 张)+ 事件环形 50 条持久化。"""
        ts = time.time()
        name = time.strftime("%Y%m%d_%H%M%S", time.localtime(ts)) + ".jpg"
        try:
            os.makedirs(self._watch_dir, exist_ok=True)
            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            if ok:
                with open(os.path.join(self._watch_dir, name), "wb") as f:
                    f.write(buf.tobytes())
            shots = sorted(x for x in os.listdir(self._watch_dir) if x.endswith(".jpg"))
            for old in shots[:-20]:
                try:
                    os.remove(os.path.join(self._watch_dir, old))
                except OSError:
                    pass
        except Exception as e:
            log.warning("watch shot save failed: %s", e)
            name = None
        with self._cond:
            self._events.append({"ts": round(ts, 1), "ratio": round(ratio, 3), "shot": name})
            self._events = self._events[-50:]
            events = list(self._events)
        try:
            with open(self._watch_events_path, "w", encoding="utf-8") as f:
                json.dump(events, f)
        except Exception as e:
            log.warning("watch events persist failed: %s", e)
        # 冷却计时用 monotonic(与 _watch_diff 同基准);事件 ts 用墙钟(展示/游标)
        self._last_event_at = time.monotonic()
        log.info("watch change event ratio=%.3f shot=%s", ratio, name)

    def watch_status(self):
        with self._cond:
            return {"mode": self._mode, "changed": self._last_changed,
                    "cooldown_sec": self._watch_cooldown, "events": len(self._events)}

    def watch_events(self, since=0.0):
        with self._cond:
            return [e for e in self._events if e["ts"] > since]

    def watch_shot(self, name):
        """按安全文件名读快照字节;任何越界都返回 None。"""
        import re
        if not name or not re.fullmatch(r"[0-9_A-Za-z]+\.jpg", name):
            return None
        path = os.path.join(self._watch_dir, name)
        if not os.path.isfile(path):
            return None
        try:
            with open(path, "rb") as f:
                return f.read()
        except OSError:
            return None

    # ---- consumers ----
    def latest(self):
        with self._cond:
            rec = self._ring[-1] if self._ring else None
            if rec is None:
                return None, {"status": self._status, "seq": self._seq}
            m = dict(rec["meta"])
            m["seq"] = rec["seq"]
            return rec["jpeg"], m

    def wait_frames(self, n, timeout=3.0):
        """返回"此刻之后的接下来 n 帧"的检测记录(不含 jpeg)。search_face 停稳后调用,
        拿到的必然是停稳之后的干净帧。超时则返回已攒到的(可能为空)。
        /frames 依赖检测框:非 face 模式时自动升级(用户确认过不自动降回)。"""
        if self._mode != "face":
            log.info("/frames requested in %s mode -> auto upgrade to face", self._mode)
            self.set_mode("face")
        n = max(1, min(int(n), 12))
        deadline = time.monotonic() + timeout
        with self._cond:
            base = self._seq
            while True:
                new = [r for r in self._ring if r["seq"] > base]
                if len(new) >= n:
                    return [self._pack(r) for r in new[:n]]
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return [self._pack(r) for r in new]
                self._cond.wait(remaining)

    @staticmethod
    def _pack(r):
        return {"seq": r["seq"], "fw": r["fw"], "fh": r["fh"], "boxes": r["boxes"],
                "embed": r.get("embed")}

    # ---- drawing ----
    def _draw(self, cv2, frame, faces, fw, fh):
        ex = ey = None
        if faces:
            t = faces[0]  # detect_faces_yunet 已按面积降序,首个即最大脸
            x, y, w, h = t["x"], t["y"], t["w"], t["h"]
            for i, b in enumerate(faces):
                bx, by, bw, bh = b["x"], b["y"], b["w"], b["h"]
                if i == 0:
                    cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), (0, 0, 255), 3)
                    cv2.circle(frame, (bx + bw // 2, by + bh // 2), 3, (0, 255, 255), -1)
                else:
                    cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), (0, 255, 0), 1)
            ex = (x + w / 2.0 - fw / 2.0) / fw
            ey = (y + h / 2.0 - fh / 2.0) / fh
        mx, my = fw // 2, fh // 2
        cv2.line(frame, (mx - 12, my), (mx + 12, my), (255, 255, 255), 1)
        cv2.line(frame, (mx, my - 12), (mx, my + 12), (255, 255, 255), 1)
        cv2.line(frame, (mx, 0), (mx, fh), (80, 80, 80), 1)
        cv2.line(frame, (0, my), (fw, my), (80, 80, 80), 1)
        centered = (ex is not None and abs(ex) < CENTER_TOL and abs(ey) < CENTER_TOL)
        lines = [
            "faces=%d  %dx%d" % (len(faces), fw, fh),
            "ex=%s ey=%s  %s" % (
                ("%+.3f" % ex) if ex is not None else "--",
                ("%+.3f" % ey) if ey is not None else "--",
                "CENTERED" if centered else ("" if ex is None else "off-center")),
        ]
        for i, txt in enumerate(lines):
            color = (0, 200, 255) if (i == 1 and centered) else (0, 255, 0)
            cv2.putText(frame, txt, (6, 18 + i * 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
        meta = {
            "status": "ok", "faces": len(faces), "frame": [int(fw), int(fh)],
            "ex": None if ex is None else round(ex, 3),
            "ey": None if ey is None else round(ey, 3),
            "centered": bool(centered), "tol": CENTER_TOL, "ts": time.time(),
            "mode": "face",
        }
        return frame, meta

    def _placeholder(self, cv2, msg):
        import numpy as np
        frame = np.zeros((240, 320, 3), dtype="uint8")
        cv2.putText(frame, msg, (18, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        with self._cond:
            self._seq += 1
            self._ring.append({"seq": self._seq, "fw": 320, "fh": 240, "boxes": [],
                               "jpeg": buf.tobytes() if ok else None, "embed": None,
                               "meta": {"status": msg, "faces": 0, "mode": self._mode}})
            self._status = msg
            self._cond.notify_all()

    def _plain_meta(self, fw, fh):
        """preview/watch 模式不检测不画框,只透出基础状态(供 /meta 与索引页)。"""
        return {"status": "ok", "faces": 0, "frame": [int(fw), int(fh)],
                "ts": time.time(), "mode": self._mode}

    # 连续取帧失败超过此秒数则自重启(相机 USB 掉盘重枚举后 OpenCV 内部句柄无法自愈)。
    # 12fps 下连续 10s 读不到帧即确定死透；旧值 60s 使每次掉盘都黑屏整整一分钟。
    STUCK_RESTART_SEC = 10.0

    def _self_restart(self):
        """execv 原地重启本进程:重置全部 OpenCV/V4L2 状态,保留当前运行模式。"""
        argv = [sys.executable, os.path.abspath(__file__)] + sys.argv[1:]
        if "--mode" in argv:
            argv[argv.index("--mode") + 1] = self._mode
        log.error("camera grab stuck >%.0fs; self-restarting (mode=%s)", self.STUCK_RESTART_SEC, self._mode)
        for h in log.handlers:
            h.flush()
        time.sleep(0.3)
        os.execv(sys.executable, argv)

    def _watch_diff(self, cv2, np, frame):
        """差帧变化检测:灰度 resize(64,48) absdiff,超阈像素占比判变化。
        参考帧无事件时缓慢更新;命中后进入冷却防连发。返回 ratio。"""
        small = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (64, 48))
        if self._watch_ref is None:
            self._watch_ref = small
            return 0.0
        diff = cv2.absdiff(small, self._watch_ref)
        ratio = float(np.count_nonzero(diff > 25)) / diff.size
        now = time.monotonic()
        in_cooldown = (now - self._last_event_at) < self._watch_cooldown
        self._last_changed = ratio > self._watch_ratio
        if self._last_changed and not in_cooldown:
            self._record_event(cv2, frame, ratio)
            self._watch_ref = small  # 事件后以新画面为参考
        elif not self._last_changed:
            # 缓慢滑动参考帧,适应光线渐变(避免开灯误报)
            self._watch_ref = cv2.addWeighted(self._watch_ref, 0.95, small, 0.05, 0)
        return round(ratio, 3)

    # ---- producer thread ----
    def _run(self):
        import cv2
        import numpy as np
        det = make_face_detector(self.score)
        if det is None:
            log.error("YuNet detector unavailable; preview will show busy placeholder")
        recog = make_face_recognizer()
        if recog is None:
            log.warning("SFace recognizer unavailable; /frames will carry no embed")
        cap = None
        reopen_at = 0.0
        frame_tick = 0
        stuck_since = None  # 取帧失败看门狗:USB 掉盘重枚举后 OpenCV 句柄无法自愈,超时 execv 自重启
        while not self._stop.is_set():
            mode = self._mode
            target_fps, quality = self._mode_params()
            interval = 1.0 / target_fps
            if cap is None and time.monotonic() >= reopen_at:
                cap, resolved = _open_camera(self.camera)
                if cap is None:
                    self._placeholder(cv2, "camera busy / unavailable")
                    stuck_since = stuck_since or time.monotonic()
                    if time.monotonic() - stuck_since > self.STUCK_RESTART_SEC:
                        self._self_restart()
                    reopen_at = time.monotonic() + 1.5
                    time.sleep(0.5)
                    continue
                if self.width:
                    cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
                    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
                log.info("stream camera opened via %s", resolved)
            t0 = time.monotonic()
            ok, frame = (cap.read() if cap is not None else (False, None))
            if not ok or frame is None:
                self._placeholder(cv2, "no frame (retrying)")
                try:
                    cap.release()
                except Exception:
                    pass
                cap = None
                stuck_since = stuck_since or time.monotonic()
                if time.monotonic() - stuck_since > self.STUCK_RESTART_SEC:
                    self._self_restart()
                reopen_at = time.monotonic() + 1.0
                time.sleep(0.3)  # 避免空转狂刷占位帧白耗 Pi CPU
                continue
            stuck_since = None
            fh, fw = frame.shape[:2]
            frame_tick += 1
            embed = None
            if mode == "face":
                # A: 每 det_every 帧检测一次,中间帧复用上帧框(检测不画在中间帧上会闪)
                if frame_tick % self._det_every == 1 or not self._last_faces:
                    self._last_faces = detect_faces_yunet(det, frame) if det is not None else []
                    # 嵌入必须在 _draw 之前算:画上去的框线/十字会污染 SFace 对齐采样的像素
                    embed = embed_face(recog, frame, self._last_faces[0]) if (recog and self._last_faces) else None
                faces = self._last_faces
                frame, meta = self._draw(cv2, frame, faces, fw, fh)
                meta["recognizer"] = recog is not None
            elif mode == "watch":
                self._watch_diff(cv2, np, frame)
                meta = self._plain_meta(fw, fh)
                meta["changed"] = self._last_changed
            else:  # preview: 纯转帧
                meta = self._plain_meta(fw, fh)
            _ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
            with self._cond:
                self._seq += 1
                self._ring.append({"seq": self._seq, "fw": int(fw), "fh": int(fh),
                                   "boxes": faces if mode == "face" else [],
                                   "jpeg": buf.tobytes() if _ok else None,
                                   "embed": embed, "meta": meta})
                self._status = "ok"
                self._cond.notify_all()
            # watch 档低频:非抓帧周期直接睡到下个检查点,不白白编码
            sleep_for = max(0.0, interval - (time.monotonic() - t0))
            if mode == "watch":
                time.sleep(max(sleep_for, 0.4))
            else:
                time.sleep(sleep_for)
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass
        log.info("stream worker stopped")


INDEX_HTML = """<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>MasterPi 人脸检测预览</title><style>
body{background:#111;color:#eee;font-family:sans-serif;margin:0;padding:16px}
h3{margin:4px 0 12px}
img{max-width:100%;border:1px solid #333}
#meta{font-family:monospace;color:#8f8;margin-top:10px;white-space:pre}
.small{color:#888;font-size:12px;margin-top:8px}
</style></head><body>
<h3>MasterPi 人脸检测预览 (DNN/YuNet) <span id="ts"></span></h3>
<img src="/stream">
<div id="meta">loading...</div>
<div class="small">绿框=检出人脸 · 红框+黄点=目标(最大)脸 · 白十字=画面中心 · ex/ey 为归一化偏差(tol=±0.14 判居中)</div>
<div class="small">search_face 运行时会自动借本预览的检测框(共用相机),无需停止预览即可边看边对准</div>
<script>
async function tick(){try{const r=await fetch('/meta');const m=await r.json();
document.getElementById('meta').textContent=JSON.stringify(m,null,2);
document.getElementById('ts').textContent=new Date().toLocaleTimeString();}catch(e){} }
setInterval(tick,500);tick();
</script></body></html>"""


def make_handler(state):
    from http.server import BaseHTTPRequestHandler

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, ctype, body):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            parsed = urlparse(self.path)
            q = parse_qs(parsed.query)
            if parsed.path == "/mode":
                mode = (q.get("set") or [""])[0]
                if mode in MODES:
                    state.set_mode(mode)
                    self._send(200, "application/json",
                               json.dumps({"ok": True, "mode": mode}).encode("utf-8"))
                else:
                    self._send(400, "application/json",
                               json.dumps({"ok": False, "error": "mode must be one of %s" % (MODES,)}).encode("utf-8"))
            else:
                self._send(404, "text/plain", b"not found")

        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/":
                self._send(200, "text/html; charset=utf-8", INDEX_HTML.encode("utf-8"))
            elif path == "/meta":
                jpeg, meta = state.latest()
                self._send(200, "application/json", json.dumps(meta).encode("utf-8"))
            elif path == "/watch/status":
                self._send(200, "application/json", json.dumps(state.watch_status()).encode("utf-8"))
            elif path == "/watch/events":
                q = parse_qs(parsed.query)
                since = float((q.get("since") or ["0"])[0])
                self._send(200, "application/json", json.dumps(state.watch_events(since)).encode("utf-8"))
            elif path == "/watch/shot":
                q = parse_qs(parsed.query)
                name = (q.get("name") or [""])[0]
                data = state.watch_shot(name)
                if data:
                    self._send(200, "image/jpeg", data)
                else:
                    self._send(404, "text/plain", b"shot not found")
            elif path == "/frames":
                q = parse_qs(parsed.query)
                n = int((q.get("n") or ["4"])[0])
                recs = state.wait_frames(n)
                self._send(200, "application/json",
                           json.dumps({"frames": recs, "status": state._status}).encode("utf-8"))
            elif path == "/shot":
                jpeg, meta = state.latest()
                if jpeg:
                    self._send(200, "image/jpeg", jpeg)
                else:
                    self._send(503, "text/plain", b"no frame yet")
            elif path == "/stream":
                self.send_response(200)
                self.send_header("Content-Type",
                                 "multipart/x-mixed-replace; boundary=%s" % BOUNDARY)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                last_seq = -1
                try:
                    while True:
                        jpeg, meta = state.latest()
                        seq = int(meta.get("seq", 0)) if isinstance(meta, dict) else 0
                        if jpeg and seq != last_seq:
                            self.wfile.write(("--%s\r\n" % BOUNDARY).encode())
                            self.wfile.write(b"Content-Type: image/jpeg\r\n")
                            self.wfile.write(("Content-Length: %d\r\n\r\n" % len(jpeg)).encode())
                            self.wfile.write(jpeg)
                            self.wfile.write(b"\r\n")
                            last_seq = seq
                        time.sleep(1.0 / state.fps)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            else:
                self._send(404, "text/plain", b"not found")

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8110)
    ap.add_argument("--camera", default="auto")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--fps", type=int, default=12)
    ap.add_argument("--score", type=float, default=0.7)
    ap.add_argument("--mode", default="face", choices=MODES)
    ap.add_argument("--det-every", type=int, default=3, help="face 模式每 N 帧检测一次(A)")
    ap.add_argument("--watch-cooldown", type=float, default=60.0, help="看家事件冷却秒数")
    args = ap.parse_args()

    cam = args.camera
    try:
        cam = int(cam)
    except (ValueError, TypeError):
        pass

    state = StreamState(cam, args.width, args.height, args.fps, args.score,
                        mode=args.mode, det_every=args.det_every,
                        watch_cooldown=args.watch_cooldown)
    state.start()

    from http.server import ThreadingHTTPServer
    httpd = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(state))
    log.info("debug stream on http://0.0.0.0:%d/  (camera=%s %dx%d @%dfps score=%.2f mode=%s det_every=%d)",
             args.port, cam, args.width, args.height, args.fps, args.score, args.mode, args.det_every)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("interrupted")
    finally:
        state.stop()
        httpd.shutdown()


if __name__ == "__main__":
    main()
