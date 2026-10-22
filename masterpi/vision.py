"""
人脸搜寻巡检:舵机扫描 + DNN(YuNet) 正面人脸检测 + SFace 身份识别。

设计约束:
- 绝不触碰底盘轮子,只动 s1 躯干/s3 颈部/s6 头部三个舵机做"上下左右转向"。
- 所有扫描角度均取自厂商动作组已实测的安全值域:
  s1 1440~2023,s3 500~1500,s6 550~2500。
- cv2/numpy 在函数内懒加载,避免拖慢进程启动(派上 SD 卡冷 import 可达数十秒,
  由 tools.py 后台线程预热)。
- 检测到即停:命中立刻中止扫描(必要时蜂鸣提示),找不到则头颈归中。
"""

import glob
import logging
import os
import time

log = logging.getLogger("masterpi.vision")

# USB 摄像头稳定标识(重枚举/重编号后仍指向同一设备)。优先 by-id 链接。
CAMERA_BY_ID_GLOB = "/dev/v4l/by-id/*camera*index0"

# 自动定位时尝试的普通索引(0~10)。
CAMERA_INDEX_SCAN = range(11)

# 扫描位序(由中心向外,label 仅用于日志/结果回显)
# (s1 躯干回转, s3 颈部俯仰, s6 头部摆动)
POSES = [
    {"label": "center",      "s1": 1500, "s3": 695,  "s6": 1500},
    {"label": "head_left",   "s1": 1500, "s3": 695,  "s6": 900},
    {"label": "head_right",  "s1": 1500, "s3": 695,  "s6": 2100},
    {"label": "body_left",   "s1": 1440, "s3": 695,  "s6": 1500},
    {"label": "body_right",  "s1": 2023, "s3": 695,  "s6": 1500},
    {"label": "look_up",     "s1": 1500, "s3": 1000, "s6": 1500},
    {"label": "look_down",   "s1": 1500, "s3": 550,  "s6": 1500},
    {"label": "wide_left",   "s1": 1440, "s3": 695,  "s6": 900},
    {"label": "wide_right",  "s1": 2023, "s3": 695,  "s6": 2100},
]

CENTER_POSE = POSES[0]

# ---- 人脸对准环参数(命中后把脸拉到画面正中) ----
# 采用开环扫描取最居中位。相机为云台/头部安装:实测躯干回转 s1 在 1440~2023 区间
# 对画面水平位置几乎无增益(cx 卡死不动),而头部回转 s6 会切实改变相机朝向
# (扫描阶段正是靠 s6 左右摆才在 head_left/head_right 位发现侧向人脸)。
# 故水平对准改用头部 s6,垂直用颈部 s3。
PAN_SERVO, PAN_MIN, PAN_MAX = 6, 700, 2300    # 头部回转(云台 pan):水平对准执行器
TILT_SERVO, TILT_MIN, TILT_MAX = 3, 500, 1500  # 颈部俯仰(云台 tilt):垂直对准执行器
SWEEP_PAN_STEPS = 6     # 水平(s6)扫描档数
SWEEP_PAN_WINDOW = 170  # 水平扫描以当前 s6 为中心的每侧半宽(收小以免把脸甩出画面)
SWEEP_TILT_STEPS = 6    # 垂直(s3)扫描档数
SWEEP_TILT_WINDOW = 130 # 垂直扫描以当前 s3 为中心的每侧半宽(收小以免丢脸)
SWEEP_TRAVEL = 0.3      # 每档舵机行程
CENTER_BUDGET_SEC = 18.0  # 对准总时间预算(需保证一轮"水平+垂直"能跑完)
CENTER_TOL = 0.14       # 归一化偏差阈值(相对画面宽/高),小于视为已对准


def _pose_spec(pose):
    return [[1, pose["s1"]], [3, pose["s3"]], [6, pose["s6"]]]


# ---- DNN 人脸检测(YuNet):替代 Haar,显著降低印刷/卡通脸误报 ----
FACE_MODEL_PATH = os.path.expanduser(
    "~/masterpi_client/models/face_detection_yunet_2023mar.onnx")
DEFAULT_SCORE = 0.7


def make_face_detector(score=DEFAULT_SCORE):
    """创建 cv2 FaceDetectorYN(YuNet)。模型缺失时返回 None(调用方自行降级)。"""
    import cv2
    if not os.path.exists(FACE_MODEL_PATH):
        log.warning("yunet model not found at %s", FACE_MODEL_PATH)
        return None
    return cv2.FaceDetectorYN.create(FACE_MODEL_PATH, "", (320, 320), score, 0.3, 5000)


def detect_faces_yunet(det, frame):
    """对一帧做 DNN 检测,返回 [{x,y,w,h,score,lm}, ...](按面积从大到小)。
    lm 为 5 关键点展平坐标(10 个 float),供 SFace 对齐取嵌入。"""
    if det is None or frame is None:
        return []
    h, w = frame.shape[:2]
    det.setInputSize((w, h))
    _ret, faces = det.detect(frame)
    out = []
    if faces is not None:
        for f in faces:
            out.append({"x": int(f[0]), "y": int(f[1]),
                        "w": int(f[2]), "h": int(f[3]),
                        "score": round(float(f[14]), 3),
                        "lm": [round(float(v), 1) for v in f[4:14]]})
    out.sort(key=lambda b: b["w"] * b["h"], reverse=True)
    return out


def _largest(boxes):
    """从一组 {x,y,w,h} 取面积最大者(无则 None)。"""
    if not boxes:
        return None
    return max(boxes, key=lambda b: b["w"] * b["h"])


# ---- SFace 身份识别(检测之后追加"认人"环节) ----
RECOG_MODEL_PATH = os.path.expanduser(
    "~/masterpi_client/models/face_recognition_sface_2021dec.onnx")


def make_face_recognizer():
    """创建 cv2 FaceRecognizerSF(SFace)。模型缺失时返回 None(调用方自行降级)。"""
    import cv2
    if not os.path.exists(RECOG_MODEL_PATH):
        log.warning("sface model not found at %s", RECOG_MODEL_PATH)
        return None
    return cv2.FaceRecognizerSF.create(RECOG_MODEL_PATH, "")


def embed_face(recog, frame, box):
    """用五点关键点对齐人脸(112x112)并提取 L2 归一化 128 维嵌入。失败返 None。
    box 需来 detect_faces_yunet(含 lm)。注意 frame 必须是未画框的干净帧。"""
    if recog is None or frame is None or not box or len(box.get("lm", [])) != 10:
        return None
    import numpy as np
    try:
        pts = np.array(box["lm"], dtype="float32").reshape((5, 2))
        aligned = recog.alignCrop(frame, pts)  # OpenCV 4.10 python 绑定的对齐方法名
        feat = recog.feature(aligned)
        vec = np.asarray(feat, dtype="float32").flatten()
        norm = float(np.linalg.norm(vec))
        if norm <= 1e-9 or vec.shape[0] != 128:
            return None
        return [round(float(v) / norm, 6) for v in vec]
    except Exception as e:
        log.warning("embed_face failed: %r", e)
        return None


def _median_box(boxes):
    """对多帧的 (x,y,w,h) 取中位数,抑制单帧抖动(空则 None)。"""
    import statistics
    if not boxes:
        return None
    x = int(statistics.median(b[0] for b in boxes))
    y = int(statistics.median(b[1] for b in boxes))
    bw = int(statistics.median(b[2] for b in boxes))
    bh = int(statistics.median(b[3] for b in boxes))
    return {"x": x, "y": y, "w": bw, "h": bh, "count": len(boxes)}


class LocalSource:
    """直接持有相机 + 本地 DNN 检测/识别(预览未运行时的路径,与旧行为一致)。"""

    def __init__(self, camera, score=DEFAULT_SCORE):
        self.cap, self.resolved = _open_camera(camera)
        self.det = make_face_detector(score) if self.cap is not None else None
        self.recog = None  # SFace 懒建(仅识别/登记路径需要)
        self.ok = self.cap is not None

    def describe(self):
        return self.resolved

    def detect_multi(self, n):
        boxes = []
        lw = lh = None
        for _ in range(n):
            ok, frame = self.cap.read()
            if not ok or frame is None:
                time.sleep(0.03)
                continue
            h, w = frame.shape[:2]
            lw, lh = w, h
            b = _largest(detect_faces_yunet(self.det, frame))
            if b:
                boxes.append((b["x"], b["y"], b["w"], b["h"]))
        return _median_box(boxes), lw, lh

    def embed_frames(self, n):
        """读 n 帧,每帧取最大脸并在干净帧上提嵌入,返回 [(box, embed|None), ...]。"""
        if self.recog is None:
            self.recog = make_face_recognizer()
        out = []
        for _ in range(n):
            ok, frame = self.cap.read()
            if not ok or frame is None:
                time.sleep(0.03)
                continue
            b = _largest(detect_faces_yunet(self.det, frame))
            if b:
                out.append((b, embed_face(self.recog, frame, b)))
        return out

    def close(self):
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass


class StreamSource:
    """向本机预览进程借"检测结果"(不自己开相机)。预览运行时用此路径,
    使 search_face 与实时预览共存且共用同一路相机,彻底消除抢占冲突。
    /frames?n=k 返回"请求之后的接下来 k 帧"检测框,故舵机停稳后再请求即得干净帧。"""

    def __init__(self, base_url, timeout=3.0):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.ok = self._probe()

    def _probe(self):
        import urllib.request
        try:
            with urllib.request.urlopen(self.base + "/meta", timeout=1.5) as r:
                r.read()
            return True
        except Exception:
            return False

    def describe(self):
        return "stream@" + self.base

    def detect_multi(self, n):
        import urllib.request
        import json
        try:
            with urllib.request.urlopen("%s/frames?n=%d" % (self.base, n),
                                        timeout=self.timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            log.warning("stream /frames failed: %r", e)
            return None, None, None
        boxes = []
        lw = lh = None
        for fr in data.get("frames", []):
            lw, lh = fr.get("fw"), fr.get("fh")
            b = _largest(fr.get("boxes", []))
            if b:
                boxes.append((b["x"], b["y"], b["w"], b["h"]))
        return _median_box(boxes), lw, lh

    def embed_frames(self, n):
        """预览进程已在干净帧上算好嵌入(/frames 的 embed 字段),这里只做搬运。"""
        import urllib.request
        import json
        try:
            with urllib.request.urlopen("%s/frames?n=%d" % (self.base, n),
                                        timeout=self.timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
        except Exception as e:
            log.warning("stream /frames (embed) failed: %r", e)
            return []
        out = []
        for fr in data.get("frames", []):
            b = _largest(fr.get("boxes", []))
            e = fr.get("embed")
            if b and e:
                out.append((b, e))
        return out

    def close(self):
        pass


def choose_source(camera, stream_url=None, score=DEFAULT_SCORE):
    """有可用预览流则借流(与预览共存),否则回退本地开相机。"""
    if stream_url:
        s = StreamSource(stream_url)
        if s.ok:
            log.info("vision using stream source %s", s.base)
            return s
        log.info("stream %s unavailable, fallback to local camera", stream_url)
    return LocalSource(camera, score)


def collect_embeds(source, frames=4):
    """从帧源采一组人脸嵌入(含无效帧过滤)。返回 [embed, ...](可能为空)。"""
    try:
        pairs = source.embed_frames(frames)
    except Exception as e:
        log.warning("collect_embeds failed: %r", e)
        return []
    return [e for (_b, e) in pairs if e]


def identify_face(source, frames=4, threshold=None):
    """取 frames 帧各自最大脸的嵌入,逐帧比对人脸库后多数表决身份。
    未命中/库空/无脸均返 person=None(识别失败不等于检测失败)。"""
    import face_db
    embeds = collect_embeds(source, frames)
    if not embeds:
        return {"person": None, "reason": "no face sample", "samples": 0}
    try:
        return face_db.identify(embeds, threshold)
    except Exception as e:
        log.warning("identify_face failed: %r", e)
        return {"person": None, "reason": repr(e), "samples": len(embeds)}


def _linspace(lo, hi, n):
    if n <= 1:
        return [int(round(lo))]
    step = (hi - lo) / (n - 1)
    return [int(round(lo + step * i)) for i in range(n)]


def _window(center_val, half, lo, hi, n):
    """以当前位姿为中心取窄窗 linspace(夹在安全区间内),兼顾细扫与不超范围。"""
    a = max(lo, center_val - half)
    b = min(hi, center_val + half)
    return _linspace(a, b, n)


def _sweep_axis(source, move_servos, base, axis, values, settle_sec, frames, deadline=None):
    """沿单一舵机轴开环扫描:逐档到位后取一帧检测,记录 (pos, cx, cy, w, h)。
    只对检到脸的档返回样本,供上层按该轴对应的画面坐标挑最居中位。"""
    samples = []
    for pos in values:
        if deadline is not None and time.monotonic() >= deadline:
            break
        cur = dict(base)
        cur[axis] = pos
        move_servos(_pose_spec(cur), SWEEP_TRAVEL)
        time.sleep(settle_sec)  # 必须 > 行程时间,待舵机到位后再抓帧
        box, w, h = source.detect_multi(frames)
        if box and w:
            cx = box["x"] + box["w"] / 2.0
            cy = box["y"] + box["h"] / 2.0
            samples.append((pos, cx, cy, int(w), int(h)))
    return samples


def _pick_center(samples, horizontal):
    """从扫描样本中挑画面中心最接近中位的一档。horizontal=True 比较 cx vs w/2。"""
    if not samples:
        return None, None
    def err(s):
        return abs(s[1] - s[3] / 2.0) if horizontal else abs(s[2] - s[4] / 2.0)
    best = min(samples, key=err)
    signed = (best[1] - best[3] / 2.0) if horizontal else (best[2] - best[4] / 2.0)
    return best[0], int(round(signed))


def _center_face(source, move_servos, cur, settle_sec, frames_per_step=4,
                 initial_box=None):
    """开环扫描对准:每轮先扫头部 s6(水平 pan)再扫颈部 s3(垂直 tilt),各取使画面
    中心最接近中线的档位。水平放在竖直之前是因为 pan 会连带扰动竖直位置,必须由随后
    的垂直扫描收尾消化;最多两轮细化,受 CENTER_BUDGET_SEC 约束。
    返回 (final_cur, last_box, centered)。"""
    cur = dict(cur)
    deadline = time.monotonic() + CENTER_BUDGET_SEC
    last_box = initial_box
    centered = False

    for p in range(2):
        # 1) 水平:先扫头部 s6(云台 pan)。实测 pan 会连带扰动人脸的竖直位置,
        #    故水平必须放在竖直之前扫,让随后的垂直扫描去消化这层耦合偏移。
        p_vals = _window(cur["s6"], SWEEP_PAN_WINDOW, PAN_MIN, PAN_MAX, SWEEP_PAN_STEPS)
        horiz = _sweep_axis(source, move_servos, cur, "s6", p_vals,
                            settle_sec, frames_per_step, deadline)
        log.info("center s6 sweep p%d: samples(pos,cx,w)=%s", p,
                 [(pos, int(cx), w) for (pos, cx, cy, w, h) in horiz])
        best6, _dx = _pick_center(horiz, horizontal=True)
        if best6 is not None:
            cur["s6"] = best6
            move_servos(_pose_spec(cur), SWEEP_TRAVEL)
            time.sleep(settle_sec)

        # 2) 垂直:再扫颈部 s3(云台 tilt),放在每轮最后使竖直成为收尾落子
        if time.monotonic() >= deadline:
            break
        t_vals = _window(cur["s3"], SWEEP_TILT_WINDOW, TILT_MIN, TILT_MAX, SWEEP_TILT_STEPS)
        vert = _sweep_axis(source, move_servos, cur, "s3", t_vals,
                           settle_sec, frames_per_step, deadline)
        log.info("center s3 sweep p%d: samples(pos,cy,h)=%s", p,
                 [(pos, int(cy), h) for (pos, cx, cy, w, h) in vert])
        best3, _dy = _pick_center(vert, horizontal=False)
        if best3 is not None:
            cur["s3"] = best3
            move_servos(_pose_spec(cur), SWEEP_TRAVEL)
            time.sleep(settle_sec)

        # 3) 轮末复检:两轴都进容差即提前收敛
        box, w, h = source.detect_multi(frames_per_step)
        if box and w:
            last_box = box
            ex = (box["x"] + box["w"] / 2.0 - w / 2.0) / w
            ey = (box["y"] + box["h"] / 2.0 - h / 2.0) / h
            centered = abs(ex) < CENTER_TOL and abs(ey) < CENTER_TOL
            if centered:
                break
        if time.monotonic() >= deadline:
            break

    # 收尾复检:仅在检到脸时据其重判;瞬时丢帧则沿用上次结果(避免把已对准误翻为未对准)
    box, w, h = source.detect_multi(frames_per_step)
    if box and w:
        last_box = box
        ex = (box["x"] + box["w"] / 2.0 - w / 2.0) / w
        ey = (box["y"] + box["h"] / 2.0 - h / 2.0) / h
        centered = abs(ex) < CENTER_TOL and abs(ey) < CENTER_TOL
        log.info("center final: ex=%.3f ey=%.3f s3=%d s6=%d centered=%s",
                 ex, ey, cur["s3"], cur["s6"], centered)
    else:
        log.info("center final: 复检未检到脸,沿用上次 centered=%s s3=%d s6=%d",
                 centered, cur["s3"], cur["s6"])
    if last_box is not None and "fw" not in last_box and w:
        last_box = dict(last_box)
        last_box["fw"] = int(w)
        last_box["fh"] = int(h)
    return cur, last_box, centered


def _open_camera(source):
    """打开摄像头,返回 (cap, resolved_source) 或 (None, None)。

    source 可为:
      "auto"        —— 优先 by-id 稳定链接,再回退逐个索引探测;
      int           —— 直接用作 /dev/videoN 索引;
      str           —— 设备路径(如 /dev/video1 或 by-id 链接)。
    判定可用:isOpened() 且能读到一帧有效彩色图像。
    """
    import cv2

    candidates = []
    if source == "auto" or source is None:
        candidates.extend(glob.glob(CAMERA_BY_ID_GLOB))
        candidates.extend(CAMERA_INDEX_SCAN)
    else:
        candidates.append(source)

    for cand in candidates:
        cap = cv2.VideoCapture(cand)
        if not cap.isOpened():
            cap.release()
            continue
        # 读一帧验证设备真的在出图(重枚举瞬间可能开着但无帧)
        ok, frame = cap.read()
        if ok and frame is not None and frame.size > 0:
            log.info("camera opened via %s", cand)
            return cap, cand
        cap.release()
    return None, None


def scan_for_faces(move_servos, on_found, camera="auto", max_scan_sec=20.0,
                   settle_sec=0.7, frames_per_pose=4, stream_url=None,
                   score=DEFAULT_SCORE, identify=True, source=None):
    """遍历 POSES 转向检测人脸(检测走 DNN YuNet),命中对准后追加 SFace 认人。

    move_servos(spec, move_sec):由调用方注入,spec=[[servo_id, position],...]
    on_found():命中回调(蜂鸣等反馈),失败不影响结果。
    stream_url:本机预览流地址(如 http://127.0.0.1:8110)。给出且在线则借其
      检测,使 search_face 与实时预览共存并共用一路相机;否则回退本地开相机。
    identify:命中并对准后是否识人(结果带 person/distance);识别失败不影响
      "已找到脸"的事实(person=None 兑底)。
    source:外部已建帧源(如登记流程引导式扫描)时直接复用,不再新建。
    返回结构化结果:{ok, found, pose, face_box|poses_tried, person, elapsed_sec}。
    """
    import cv2

    own_source = source is None
    source = choose_source(camera, stream_url, score) if own_source else source
    if not source.ok:
        return {"ok": False, "action": "vision.search_face", "camera": camera,
                "error": "no usable camera found (check /dev/v4l/by-id)"}
    if own_source and isinstance(source, LocalSource) and source.cap is not None:
        source.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 320)
        source.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 240)
    resolved = source.describe()

    start = time.monotonic()
    deadline = start + max_scan_sec
    tried = []
    try:
        for pose in POSES:
            if time.monotonic() >= deadline:
                log.warning("scan budget %ss exhausted at %s", max_scan_sec, pose["label"])
                break
            move_servos(_pose_spec(pose), 0.5)
            time.sleep(settle_sec)  # 必须 > 行程时间,待舵机到位后再抓帧
            tried.append(pose["label"])
            box, fw, fh = source.detect_multi(frames_per_pose)
            if box is not None:
                box = dict(box)
                if fw:
                    box["fw"] = int(fw)
                    box["fh"] = int(fh)
                # 命中:先转朝向(把脸拉到画面正中),再反馈提示。
                directed = dict(pose)
                centered = False
                try:
                    directed, reb, centered = _center_face(
                        source, move_servos, pose, settle_sec,
                        initial_box=box)
                    if reb:
                        box = reb
                except Exception as e:  # 对准失败不影响已命中事实
                    log.warning("center-face failed: %r", e)
                if on_found:
                    try:
                        on_found()
                    except Exception as e:  # 提示音失败不影响搜寻结果
                        log.warning("on_found feedback failed: %r", e)
                # 认人:对准之后才做,拿到的是正脸稳定帧;失败不改变"已命中"事实
                identity = {}
                if identify:
                    try:
                        identity = identify_face(source, frames=frames_per_pose)
                    except Exception as e:
                        log.warning("identify after hit failed: %r", e)
                        identity = {"person": None, "reason": repr(e)}
                log.info("face found pose=%s box=%s centered=%s person=%s tried=%s",
                         pose["label"], box, centered, identity.get("person"), tried)
                return {"ok": True, "dryRun": False, "action": "vision.search_face",
                        "found": True, "pose": pose["label"], "face_box": box,
                        "centered": centered, "facing": directed,
                        "person": identity.get("person"),
                        "person_id": identity.get("person_id"),
                        "person_info": identity,
                        "source": resolved, "camera": resolved, "poses_tried": tried,
                        "elapsed_sec": round(time.monotonic() - start, 1)}
        # 全圈无果:头颈归中,恢复待命姿态
        try:
            move_servos(_pose_spec(CENTER_POSE), 0.6)
        except Exception as e:
            log.warning("recenter after failed scan failed: %r", e)
        log.info("no face found, tried=%s", tried)
        return {"ok": True, "dryRun": False, "action": "vision.search_face",
                "found": False, "source": resolved, "camera": resolved,
                "poses_tried": tried,
                "elapsed_sec": round(time.monotonic() - start, 1)}
    finally:
        if own_source:
            source.close()


def detect_colors(camera="auto", lab_file="/home/pi/MasterPi/lab_config.yaml",
                  timeout_sec=2.0, min_area=800):
    """纯相机颜色识别(绝不碰轮子)：按厂商 LAB 阈值表检测画面中出现的颜色。
    返回 {ok, action, colors:[{name,area,box}], frame:[w,h]}。"""
    import cv2
    import yaml
    try:
        with open(lab_file, "r", encoding="utf-8") as f:
            lab_data = yaml.safe_load(f) or {}
    except Exception as e:
        return {"ok": False, "action": "vision.color_detect",
                "error": "lab file load failed: %r" % e}
    cap, resolved = _open_camera(camera)
    if cap is None:
        return {"ok": False, "action": "vision.color_detect", "camera": camera,
                "error": "no usable camera found"}
    start = time.monotonic()
    fw = fh = None
    found = {}
    try:
        while time.monotonic() - start < timeout_sec:
            ok, frame = cap.read()
            if not ok or frame is None:
                time.sleep(0.03)
                continue
            fh, fw = frame.shape[:2]
            lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
            for name, rng in lab_data.items():
                lo = rng.get("min"); hi = rng.get("max")
                if not lo or not hi:
                    continue
                mask = cv2.inRange(lab, tuple(lo), tuple(hi))
                mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,
                                        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
                cnts = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[-2]
                if not cnts:
                    continue
                c = max(cnts, key=cv2.contourArea)
                area = float(cv2.contourArea(c))
                if area >= min_area:
                    prev = found.get(name)
                    if prev is None or area > prev["area"]:
                        x, y, w, h = cv2.boundingRect(c)
                        found[name] = {"name": name, "area": int(area),
                                       "box": {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}}
            time.sleep(0.02)
        colors = sorted(found.values(), key=lambda v: -v["area"])
        return {"ok": True, "dryRun": False, "action": "vision.color_detect",
                "camera": resolved, "frame": [fw, fh] if fw else None,
                "colors": colors,
                "elapsed_sec": round(time.monotonic() - start, 1)}
    except Exception as e:
        log.exception("detect_colors failed")
        return {"ok": False, "action": "vision.color_detect", "error": repr(e)}
    finally:
        cap.release()


def snapshot(camera="auto", out_dir="~/masterpi_client/snapshots"):
    """抓一帧存为 JPEG(绝不碰轮子)，返回文件路径与尺寸，供排查对准/画面。"""
    import os
    import cv2
    out_dir = os.path.expanduser(out_dir)
    try:
        os.makedirs(out_dir, exist_ok=True)
    except Exception as e:
        return {"ok": False, "action": "camera.snapshot", "error": "mkdir failed: %r" % e}
    cap, resolved = _open_camera(camera)
    if cap is None:
        return {"ok": False, "action": "camera.snapshot", "camera": camera,
                "error": "no usable camera found"}
    try:
        frame = None
        for _ in range(8):
            ok, f = cap.read()
            if ok and f is not None:
                frame = f
                break
            time.sleep(0.05)
        if frame is None:
            return {"ok": False, "action": "camera.snapshot", "camera": resolved,
                    "error": "no frame captured"}
        ts = time.strftime("%Y%m%d_%H%M%S")
        path = os.path.join(out_dir, "snap_%s.jpg" % ts)
        if not cv2.imwrite(path, frame):
            return {"ok": False, "action": "camera.snapshot", "error": "imwrite failed"}
        fh, fw = frame.shape[:2]
        return {"ok": True, "dryRun": False, "action": "camera.snapshot",
                "camera": resolved, "path": path, "width": int(fw), "height": int(fh)}
    except Exception as e:
        log.exception("snapshot failed")
        return {"ok": False, "action": "camera.snapshot", "error": repr(e)}
    finally:
        cap.release()
