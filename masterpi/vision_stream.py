#!/usr/bin/env python3
"""
人脸检测实时预览(调试用外接视频窗口) + 检测结果共享端点。

用途:
1) 浏览器打开 http://<pi-ip>:8110/ 看摄像头实时画面,每帧叠加
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
"""

import argparse
import json
import logging
import threading
import time
from collections import deque
from urllib.parse import urlparse, parse_qs

from vision import (_open_camera, CENTER_TOL, make_face_detector, detect_faces_yunet,
                    make_face_recognizer, embed_face)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
log = logging.getLogger("masterpi.vision_stream")

BOUNDARY = "masterpistream"


class StreamState:
    """后台取流线程:独占相机 + DNN 检测,维护环形帧缓冲供 /stream 与 /frames 共享。"""

    def __init__(self, camera, width, height, fps, score):
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

    # ---- lifecycle ----
    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

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
        拿到的必然是停稳之后的干净帧。超时则返回已攒到的(可能为空)。"""
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
                               "meta": {"status": msg, "faces": 0}})
            self._status = msg
            self._cond.notify_all()

    # ---- producer thread ----
    def _run(self):
        import cv2
        det = make_face_detector(self.score)
        if det is None:
            log.error("YuNet detector unavailable; preview will show busy placeholder")
        recog = make_face_recognizer()
        if recog is None:
            log.warning("SFace recognizer unavailable; /frames will carry no embed")
        interval = 1.0 / self.fps
        cap = None
        reopen_at = 0.0
        while not self._stop.is_set():
            if cap is None and time.monotonic() >= reopen_at:
                cap, resolved = _open_camera(self.camera)
                if cap is None:
                    self._placeholder(cv2, "camera busy / unavailable")
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
                reopen_at = time.monotonic() + 1.0
                continue
            fh, fw = frame.shape[:2]
            faces = detect_faces_yunet(det, frame) if det is not None else []
            # 嵌入必须在 _draw 之前算:画上去的框线/十字会污染 SFace 对齐采样的像素
            embed = embed_face(recog, frame, faces[0]) if (recog and faces) else None
            frame, meta = self._draw(cv2, frame, faces, fw, fh)
            meta["recognizer"] = recog is not None
            _ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            with self._cond:
                self._seq += 1
                self._ring.append({"seq": self._seq, "fw": int(fw), "fh": int(fh),
                                   "boxes": faces, "jpeg": buf.tobytes() if _ok else None,
                                   "embed": embed, "meta": meta})
                self._status = "ok"
                self._cond.notify_all()
            time.sleep(max(0.0, interval - (time.monotonic() - t0)))
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

        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/":
                self._send(200, "text/html; charset=utf-8", INDEX_HTML.encode("utf-8"))
            elif path == "/meta":
                jpeg, meta = state.latest()
                self._send(200, "application/json", json.dumps(meta).encode("utf-8"))
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
    args = ap.parse_args()

    cam = args.camera
    try:
        cam = int(cam)
    except (ValueError, TypeError):
        pass

    state = StreamState(cam, args.width, args.height, args.fps, args.score)
    state.start()

    from http.server import ThreadingHTTPServer
    httpd = ThreadingHTTPServer(("0.0.0.0", args.port), make_handler(state))
    log.info("debug stream on http://0.0.0.0:%d/  (camera=%s %dx%d @%dfps score=%.2f)",
             args.port, cam, args.width, args.height, args.fps, args.score)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("interrupted")
    finally:
        state.stop()
        httpd.shutdown()


if __name__ == "__main__":
    main()
