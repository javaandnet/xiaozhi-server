"""
MasterPi 硬件抽象层。

默认 dryRun=True:所有电机/音频动作只打印指令,不触碰真实硬件。
在 Raspberry Pi 上把 dryRun 关掉后,懒加载幻尔(Hiwonder)官方 SDK,
用下面这些"厂商已验证的安全动作"驱动真实舵机/底盘。

安全红线:对外只暴露语义宏(禁止 LLM 直接给关节角度/坐标);
速度、时长在此硬限幅;底盘每次移动后保证收油(stop)。
"""

import logging
import os
import sys
import threading
import time

log = logging.getLogger("masterpi.robot")

# 厂商预置动作组(仅舵机,绝不触碰底盘电机)。来自 ~/MasterPi/action_groups。
GESTURE_ACTION_GROUPS = {
    "reset": "stand",
    "greet": "Hiwonder",
    "thanks": "Hiwonder",
    "wave": "Hiwonder1",
    "reach_left": "move_to_the_left_front",
    "reach_right": "move_to_the_right_front",
    # vendor full shake choreography (9 frames), replaces the rough servo-6 OSC
    "shake": "shake_head",
    # generated groups (scripts/generate_action_groups.py), composed only from
    # servo values already used by vendor action groups -> mechanically safe
    "bow": "bow",
    "raise_right": "raise_right",
    "dance": "dance",
}

# 舵机往复微动作(取自厂商 color_detect.py 的"点头"实现)。
# gesture -> (servo_id, low, high, repeat, move_sec)
GESTURE_OSC = {
    "nod": (3, 600, 800, 3, 0.2),
}

# 语义宏支持的全部臂动作名(供 tools schema 使用)。
ARM_POSES = sorted(list(GESTURE_ACTION_GROUPS) + list(GESTURE_OSC))


class Robot:
    def __init__(self, config=None):
        cfg = config or {}
        self.dry_run = bool(cfg.get("dryRun", True))
        rc = cfg.get("robot", {})
        self.serial_device = rc.get("serialDevice", "/dev/ttyAMA0")
        # 厂商底盘线速度范围 0~100;默认上限收到 60 以求稳。
        self.max_velocity = int(rc.get("maxVelocity", 60))
        self.max_duration = float(rc.get("maxDurationSec", 5.0))
        # 安全红线:底盘(麦轮)默认禁止真机动作(机器常放桌上,一动有坠落风险),
        # 仅当 robot.allowChassis=true 显式放开后,drive 才会下发到电机。
        self.allow_chassis = bool(rc.get("allowChassis", False))
        # 摄像头来源:默认 "auto"(优先 /dev/v4l/by-id 稳定链接,回退索引探测);
        # 也可在 config 里写 int 索引或 str 设备路径(如 "/dev/video1")。
        self.camera_device = rc.get("cameraDevice", "auto")
        # 本机人脸预览流地址:search_face 优先向它借"检测结果"以与预览共存(共用一路
        # 相机);留空或连不上则回退本地开相机。可用 config.vision.streamUrl 覆盖。
        self.stream_url = (rc.get("streamUrl")
                           or (rc.get("vision", {}) or {}).get("streamUrl")
                           or "http://127.0.0.1:8110")
        self._sdk_root = os.path.expanduser(rc.get("sdkRoot", "~/MasterPi/masterpi_sdk/common_sdk"))
        self._kin_root = os.path.expanduser(rc.get("kinematicsRoot", "~/MasterPi/masterpi_sdk/kinematics_sdk"))
        self._lab_file = os.path.expanduser(rc.get("labFile", "~/MasterPi/lab_config.yaml"))
        self._board = None
        self._chassis = None
        self._agc = None
        self._sonar = None
        # 底盘异步执行：启动电机后立即回 ACK，定时收油；新指令/急停取消改挂旧定时器
        self._brake_timer = None
        log.info("Robot init dryRun=%s serial=%s maxVelocity=%s maxDuration=%s",
                 self.dry_run, self.serial_device, self.max_velocity, self.max_duration)

    # ---- 懒加载真机后端:整进程只持有一个串口句柄(mecanum 模块内部已建 Board) ----
    def _hw(self):
        if self._board is not None:
            return True
        try:
            if self._sdk_root not in sys.path:
                sys.path.insert(0, self._sdk_root)
            import common.mecanum as mecanum            # 导入即创建 board=/dev/ttyAMA0
            from common.action_group_control import ActionGroupController
            self._board = mecanum.board                 # 复用同一 Board,避免二次占用串口
            self._board.enable_reception(True)
            self._chassis = mecanum.MecanumChassis()
            self._agc = ActionGroupController(self._board)
            log.info("hardware backend ready (serial=%s)", self.serial_device)
            return True
        except Exception as e:
            log.error("hardware backend unavailable: %r", e)
            return False

    def _dry(self, action, params):
        log.info("[DRYRUN] %s %s", action, params)
        return {"ok": True, "dryRun": True, "action": action, "params": params}

    def _pending(self, action, params):
        """真机尚未接线的挂点:如实返回未实现,不假装成功。"""
        if self.dry_run:
            return self._dry(action, params)
        log.warning("[REAL] %s is not wired to hardware yet", action)
        return {"ok": False, "dryRun": False, "action": action, "params": params,
                "error": "not implemented on hardware yet"}

    # ---------------- 底盘 ----------------
    def drive(self, direction, duration_sec=1.0, speed=0.3):
        direction = str(direction).lower()
        # 极坐标角度真机实测定版：180°=前 0°=后 90°=右 270°=左（SDK 文档注释与实测相反，以实测为准）
        mapping = {"forward": (180, 0), "backward": (0, 0),
                   "left": (270, 0), "right": (90, 0),
                   "turn_left": (0, -1), "turn_right": (0, 1)}
        if direction != "stop" and direction not in mapping:
            return {"ok": False, "error": "unknown direction: %s" % direction}
        duration_sec = max(0.0, min(self.max_duration, float(duration_sec)))
        velocity = max(0, min(self.max_velocity, int(float(speed) / 0.5 * 100)))
        params = {"direction": direction, "velocity": velocity, "duration_sec": duration_sec}
        if self.dry_run:
            return self._dry("chassis.drive", params)
        if not self.allow_chassis:
            log.warning("[REAL] chassis.drive refused: chassis motion disabled "
                        "(set robot.allowChassis=true to enable)")
            return {"ok": False, "dryRun": False, "action": "chassis.drive", "params": params,
                    "error": "chassis motion disabled for safety (robot on table)"}
        if not self._hw():
            return {"ok": False, "error": "hardware unavailable"}
        try:
            if direction == "stop":
                if self._brake_timer:
                    self._brake_timer.cancel()
                    self._brake_timer = None
                self._chassis.reset_motors()
                log.info("[REAL] chassis.stop")
                return {"ok": True, "dryRun": False, "action": "chassis.stop"}
            deg, ang = mapping[direction]
            self._chassis.set_velocity(velocity, deg, ang)
            # 不再 sleep(duration) 后才回包（请求往返被动作时长拖慢）：立即回 ACK，
            # 后台定时收油；后续 drive/stop 会 cancel 本定时器改挂自己的（后令为准）
            if self._brake_timer:
                self._brake_timer.cancel()
        
            def _brake():
                try:
                    self._chassis.reset_motors()
                except Exception as e:
                    log.warning("[REAL] chassis scheduled brake failed: %r", e)
        
            self._brake_timer = threading.Timer(duration_sec, _brake)
            self._brake_timer.daemon = True
            self._brake_timer.start()
            log.info("[REAL] chassis.drive (async, brake in %.2fs) %s", duration_sec, params)
            return {"ok": True, "dryRun": False, "action": "chassis.drive", "params": params,
                    "async": True}
        except Exception as e:
            return {"ok": False, "error": repr(e)}

    # ---------------- 机械臂语义宏 ----------------
    def arm_pose(self, pose):
        pose = str(pose).lower()
        if pose not in GESTURE_ACTION_GROUPS and pose not in GESTURE_OSC:
            return {"ok": False, "error": "unknown pose: %s" % pose}
        if self.dry_run:
            return self._dry("arm.gesture", {"pose": pose})
        if not self._hw():
            return {"ok": False, "error": "hardware unavailable"}
        try:
            if pose in GESTURE_ACTION_GROUPS:
                self._agc.runAction(GESTURE_ACTION_GROUPS[pose])
            else:
                sid, low, high, repeat, mv = GESTURE_OSC[pose]
                for _ in range(repeat):
                    self._board.pwm_servo_set_position(mv, [[sid, low]])
                    time.sleep(mv + 0.05)
                    self._board.pwm_servo_set_position(mv, [[sid, high]])
                    time.sleep(mv + 0.05)
            log.info("[REAL] arm.gesture pose=%s", pose)
            return {"ok": True, "dryRun": False, "action": "arm.gesture", "params": {"pose": pose}}
        except Exception as e:
            return {"ok": False, "error": repr(e)}

    # ---------------- 视觉巡检:搜寻人脸(舵机扫描 + DNN/YuNet 检测 + SFace 认人) ----------------
    def search_face(self, max_scan_sec=20.0):
        """转动躯干/颈部/头部做上下左右巡视,用摄像头寻找人脸;绝不碰轮子。
        命中:停止扫描+蜂鸣提示,返回 found=true 与人脸框,并对准后识人(person)。
        若本机预览流在线则借其检测(与实时预览共存),否则回退本地开相机。"""
        import vision
        max_scan_sec = max(5.0, min(25.0, float(max_scan_sec)))
        params = {"max_scan_sec": max_scan_sec, "camera": self.camera_device,
                  "stream_url": self.stream_url}
        if self.dry_run:
            return self._dry("vision.search_face", params)
        if not self._hw():
            return {"ok": False, "error": "hardware unavailable"}

        def _move(spec, move_sec):
            self._board.pwm_servo_set_position(move_sec, spec)

        try:
            return vision.scan_for_faces(_move, self.beep,
                                         camera=self.camera_device,
                                         max_scan_sec=max_scan_sec,
                                         stream_url=self.stream_url)
        except Exception as e:
            log.exception("search_face failed")
            return {"ok": False, "action": "vision.search_face", "error": repr(e)}

    # ---------------- 人脸识别:登记/识人/库管理(纯相机+对准动作,绝不碰轮子) ----------------
    def face_enroll(self, name, frames=5, guided=True, id=None):
        """引导式登记一个人到人脸库:先看当前画面有无够大的正脸,没有则复用
        search_face 的扫描+对准把脸摆正,再连续采 frames 帧 SFace 嵌入入库。
        id 可选(缺省自动生成 p_xxxxxx,库内唯一);预览流在线时借帧(与预览共存)。"""
        import vision
        import face_db
        frames = max(3, min(8, int(frames)))
        name = str(name or "").strip()
        pid = str(id or "").strip()
        params = {"name": name, "frames": frames, "id": pid or None}
        if self.dry_run:
            return self._dry("vision.face_enroll", params)
        if not name:
            return {"ok": False, "error": "empty name"}
        if not self._hw():
            return {"ok": False, "error": "hardware unavailable"}

        def _move(spec, move_sec):
            self._board.pwm_servo_set_position(move_sec, spec)

        source = vision.choose_source(self.camera_device, self.stream_url)
        try:
            if not source.ok:
                return {"ok": False, "action": "vision.face_enroll",
                        "error": "no usable camera found (check /dev/v4l/by-id)"}
            if guided:
                box, w, _h = source.detect_multi(3)
                if box is None or (w and box["w"] < 0.18 * w):
                    log.info("face enroll guide: no sizable face in view, scan+center first")
                    scan = vision.scan_for_faces(_move, self.beep,
                                                 camera=self.camera_device,
                                                 max_scan_sec=15.0,
                                                 stream_url=self.stream_url,
                                                 identify=False, source=source)
                    if not scan.get("found"):
                        return {"ok": False, "action": "vision.face_enroll",
                                "enrolled": False, "name": name,
                                "error": "no face found for enrollment"}
            embeds = vision.collect_embeds(source, frames)
            if not embeds:
                return {"ok": False, "action": "vision.face_enroll", "enrolled": False,
                        "name": name, "error": "no face embedding collected"}
            try:
                res = face_db.enroll(name, embeds, pid=pid or None)
            except ValueError as e:  # id/称呼重复查重等,如实回报
                return {"ok": False, "action": "vision.face_enroll", "enrolled": False,
                        "name": name, "error": str(e)}
            log.info("[REAL] vision.face_enroll id=%s name=%s samples=%s collected=%s",
                     res["id"], res["name"], res["samples"], len(embeds))
            return {"ok": True, "dryRun": False, "action": "vision.face_enroll",
                    "enrolled": True, "id": res["id"], "name": res["name"],
                    "samples": res["samples"], "collected": len(embeds)}
        except Exception as e:
            log.exception("face_enroll failed")
            return {"ok": False, "action": "vision.face_enroll", "error": repr(e)}
        finally:
            source.close()

    def face_recognize(self, frames=4):
        """只识人不扫描:当前画面取 frames 帧嵌入,多数表决出身份(person 可为 null)。"""
        import vision
        frames = max(2, min(8, int(frames)))
        params = {"frames": frames}
        if self.dry_run:
            return self._dry("vision.face_recognize", params)
        source = vision.choose_source(self.camera_device, self.stream_url)
        try:
            if not source.ok:
                return {"ok": False, "action": "vision.face_recognize",
                        "error": "no usable camera found"}
            info = vision.identify_face(source, frames)
            log.info("[REAL] vision.face_recognize person=%s id=%s",
                     info.get("person"), info.get("person_id"))
            return {"ok": True, "dryRun": False, "action": "vision.face_recognize",
                    "person": info.get("person"), "person_id": info.get("person_id"),
                    "detail": info}
        except Exception as e:
            log.exception("face_recognize failed")
            return {"ok": False, "action": "vision.face_recognize", "error": repr(e)}
        finally:
            source.close()

    def face_list(self):
        """列人脸库(纯 JSON 读取,不动相机不动硬件)。"""
        import face_db
        if self.dry_run:
            return self._dry("vision.face_list", {})
        try:
            return {"ok": True, "dryRun": False, "action": "vision.face_list",
                    "persons": face_db.list_persons(),
                    "current_login": face_db.get_login(),
                    "threshold": face_db.get_threshold()}
        except Exception as e:
            return {"ok": False, "action": "vision.face_list", "error": repr(e)}

    def face_rename(self, key, new_id=None, new_name=None):
        """修改已登记成员的 ID/称呼(纯 JSON 写入,按 id 定位,含重复校验)。"""
        import face_db
        key = str(key or "").strip()
        if self.dry_run:
            return self._dry("vision.face_rename",
                             {"key": key, "id": new_id, "name": new_name})
        if not key:
            return {"ok": False, "error": "empty key"}
        try:
            res = face_db.rename(key, new_id, new_name)
            return {"ok": True, "dryRun": False, "action": "vision.face_rename", **res}
        except ValueError as e:
            return {"ok": False, "action": "vision.face_rename", "error": str(e)}
        except Exception as e:
            return {"ok": False, "action": "vision.face_rename", "error": repr(e)}

    def face_login(self, frames=4):
        """人脸识别登录:扫脸识人,认出已登记成员则记为当前登录人。
        受 config robot.vision.faceLoginEnabled 控制(默认关闭);只识人不扫描。"""
        import vision
        import face_db
        frames = max(2, min(8, int(frames)))
        if self.dry_run:
            return self._dry("vision.face_login", {"frames": frames})
        if not face_db.get_face_login_enabled():
            log.info("vision.face_login refused: feature disabled (faceLoginEnabled=false)")
            return {"ok": False, "action": "vision.face_login", "disabled": True,
                    "logged_in": False,
                    "error": "人脸登录功能未开启(默认关闭);需先在人脸库设置中打开开关"}
        source = vision.choose_source(self.camera_device, self.stream_url)
        try:
            if not source.ok:
                return {"ok": False, "action": "vision.face_login",
                        "error": "no usable camera found"}
            info = vision.identify_face(source, frames)
            if not info.get("person_id"):
                log.info("vision.face_login denied: no registered face matched")
                return {"ok": True, "dryRun": False, "action": "vision.face_login",
                        "logged_in": False, "reason": info.get("reason", "no match"),
                        "detail": info}
            res = face_db.login(info["person_id"], distance=info.get("distance"))
            log.info("[REAL] vision.face_login id=%s name=%s", res["id"], res["name"])
            return {"ok": True, "dryRun": False, "action": "vision.face_login",
                    "logged_in": True, "id": res["id"], "name": res["name"],
                    "ts": res["ts"], "distance": info.get("distance"),
                    "votes": info.get("votes")}
        except Exception as e:
            log.exception("face_login failed")
            return {"ok": False, "action": "vision.face_login", "error": repr(e)}
        finally:
            source.close()

    def face_logout(self):
        """退出登录(清除当前登录人,纯 JSON 写入)。"""
        import face_db
        if self.dry_run:
            return self._dry("vision.face_logout", {})
        try:
            return {"ok": True, "dryRun": False, "action": "vision.face_logout",
                    **face_db.login(None)}
        except Exception as e:
            return {"ok": False, "action": "vision.face_logout", "error": repr(e)}

    def face_delete(self, name):
        """从人脸库删除指定姓名(纯 JSON 写入)。"""
        import face_db
        name = str(name or "").strip()
        if self.dry_run:
            return self._dry("vision.face_delete", {"name": name})
        if not name:
            return {"ok": False, "error": "empty name"}
        try:
            res = face_db.delete_person(name)
            return {"ok": True, "dryRun": False, "action": "vision.face_delete",
                    "deleted": res["deleted"], "id": res.get("id"), "name": name}
        except Exception as e:
            return {"ok": False, "action": "vision.face_delete", "error": repr(e)}

    def face_align(self, action="center", step=100):
        """手动微调相机云台做取景对齐:只动 s3(颈俯仰)/s6(头水平),绝不碰轮子/躯干。
        action: up/down 调俯仰(仰起为正), left/right 调水平, center 回中位。
        用于登记向导开始前把画面正对被登记者的脸。"""
        action = str(action or "center").strip().lower()
        try:
            step = max(20, min(400, int(step)))
        except Exception:
            step = 100
        if self.dry_run:
            return self._dry("vision.face_align", {"action": action, "step": step})
        if not self._hw():
            return {"ok": False, "error": "hardware unavailable"}
        cur = getattr(self, "_cam_pose", None) or {"s3": 695, "s6": 1500}
        s3, s6 = int(cur["s3"]), int(cur["s6"])
        if action == "up":
            s3 = min(1500, s3 + step)
        elif action == "down":
            s3 = max(500, s3 - step)
        elif action == "left":
            s6 = max(550, s6 - step)
        elif action == "right":
            s6 = min(2500, s6 + step)
        elif action in ("center", "reset"):
            s3, s6 = 695, 1500
        else:
            return {"ok": False, "action": "vision.face_align", "error": "bad action: " + action}
        self._cam_pose = {"s3": s3, "s6": s6}
        try:
            # 执行时间随行程自适应：小步微调保持 0.35s 响应，回中大行程变成匀速扫回，
            # 避免舵机全速甩动冲击齿轮（行程 1000 约 0.85s）。
            travel = max(abs(s3 - int(cur["s3"])), abs(s6 - int(cur["s6"])))
            dur = max(0.35, min(1.5, 0.25 + travel * 0.0006))
            self._board.pwm_servo_set_position(dur, [[3, s3], [6, s6]])
            log.info("[REAL] vision.face_align action=%s s3=%s s6=%s dur=%.2fs", action, s3, s6, dur)
            return {"ok": True, "dryRun": False, "action": "vision.face_align",
                    "align": action, "s3": s3, "s6": s6}
        except Exception as e:
            return {"ok": False, "action": "vision.face_align", "error": repr(e)}

    # ---------------- 蜂鸣(链路/存在性提示) ----------------
    def beep(self):
        if self.dry_run:
            return self._dry("device.beep", {})
        if not self._hw():
            return {"ok": False, "error": "hardware unavailable"}
        try:
            self._board.set_buzzer(1900, 0.1, 0.9, 1)
            log.info("[REAL] device.beep")
            return {"ok": True, "dryRun": False, "action": "device.beep"}
        except Exception as e:
            return {"ok": False, "error": repr(e)}

    # ---------------- 传感器 / 灯 / 相机 / 臂 IK(均为非底盘能力,安全) ----------------
    def _sonar_obj(self):
        """懒加载超声波/RGB 模块(I2C 0x77,独立于串口 board)。"""
        if self._sonar is not None:
            return self._sonar
        if not self._hw():  # 保证 common_sdk 已在 sys.path
            return None
        try:
            from common.sonar import Sonar
            self._sonar = Sonar()
            self._sonar.setRGBMode(0)
            return self._sonar
        except Exception as e:
            log.error("sonar backend unavailable: %r", e)
            return None

    def get_battery(self):
        """读电池电压(board.get_battery 需 enable_reception,回报为原始值)。"""
        if self.dry_run:
            return self._dry("device.get_battery", {})
        if not self._hw():
            return {"ok": False, "error": "hardware unavailable"}
        try:
            raw = None
            for _ in range(10):  # 等待一个 sys 报文入队(最多 ~1s)
                raw = self._board.get_battery()
                if raw is not None:
                    break
                time.sleep(0.1)
            voltage_v = round(raw / 1000.0, 2) if raw else None  # 假设厂商回报为 mV
            log.info("[REAL] device.get_battery raw=%s volt=%s", raw, voltage_v)
            return {"ok": True, "dryRun": False, "action": "device.get_battery",
                    "raw": raw, "voltage_v": voltage_v}
        except Exception as e:
            return {"ok": False, "error": repr(e)}

    def get_distance(self):
        """超声波测前方障碍物距离(不动车),返回 cm。"""
        if self.dry_run:
            return self._dry("device.get_distance", {})
        s = self._sonar_obj()
        if s is None:
            return {"ok": False, "error": "sonar unavailable"}
        try:
            mm = s.getDistance()
            cm = round(mm / 10.0, 1) if isinstance(mm, (int, float)) and 0 < mm < 5000 else None
            log.info("[REAL] device.get_distance mm=%s cm=%s", mm, cm)
            return {"ok": True, "dryRun": False, "action": "device.get_distance",
                    "mm": mm, "cm": cm, "clear": cm is not None}
        except Exception as e:
            return {"ok": False, "error": repr(e)}

    _RGB_PRESET = {
        "red": (255, 0, 0), "green": (0, 255, 0), "blue": (0, 0, 255),
        "yellow": (255, 255, 0), "cyan": (0, 255, 255), "magenta": (255, 0, 255),
        "white": (255, 255, 255), "orange": (255, 128, 0), "off": (0, 0, 0),
        "black": (0, 0, 0),
    }

    def _parse_color(self, color):
        c = str(color).strip().lower()
        if c in self._RGB_PRESET:
            return self._RGB_PRESET[c]
        if c.startswith("#") and len(c) == 7:
            try:
                return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))
            except ValueError:
                return None
        return None

    def set_rgb(self, color, index="both", breath=False, cycle_ms=2000):
        """设扩展板两盏 RGB 灯颜色(不动车)。走厂商串口 board.set_rgb(非 I2C)。
        color=预设名或 #RRGGBB;breath 串口不支持,忽略。"""
        rgb = self._parse_color(color)
        if rgb is None:
            return {"ok": False, "error": "unknown color: %s" % color}
        params = {"color": list(rgb), "index": index}
        if self.dry_run:
            return self._dry("device.set_rgb", params)
        if not self._hw():
            return {"ok": False, "error": "hardware unavailable"}
        try:
            r, g, b = rgb
            idx = [1, 2] if index == "both" else (
                [1] if str(index) in ("0", "1", "left", "a") else
                [2] if str(index) in ("1", "2", "right", "b") else [1, 2])
            self._board.set_rgb([[i, r, g, b] for i in idx])
            log.info("[REAL] device.set_rgb %s idx=%s (serial)", params, idx)
            return {"ok": True, "dryRun": False, "action": "device.set_rgb",
                    "params": params, "backend": "serial"}
        except Exception as e:
            return {"ok": False, "error": repr(e)}

    # ---------------- 机械臂逆运动学底层:安全盒 / 夹爪 / IK 移动(均不动车轮) ----------------
    # 默认安全盒(供 robot_arm_ik / robot_press):比厂商实测保守,防止误撞。
    # zMin 放宽到 -3:IK 的 z 原点=臂底座(在桌面之上),桌面物体在负 z 区,需探到负值才能夹稳壳体。
    _IK_BOX = {"xAbs": 12.0, "yMin": 0.0, "yMax": 16.0, "zMin": -3.0, "zMax": 30.0}
    # 抓取放宽盒(按厂商 color_sorting 实测可达:x±18 / y0~17 / z 低到桌面,抓矮物需 z<2)。
    _GRASP_BOX = {"xAbs": 18.0, "yMin": 0.0, "yMax": 17.0, "zMin": -3.0, "zMax": 30.0}
    # 夹爪(servo1)脉宽:开 2000 / 夹紧 1500 / 半开释放 1800(均来自厂商 color_sorting)。
    _GRIP_OPEN = 2000
    _GRIP_CLOSE = 1500
    _GRIP_RELEASE = 1800
    # 视觉自校验机位 (x,y,z,pitch):真机标定得出——臂摆此中性位姿时头部相机
    # 能把桌面抓取区(含白色物体)清楚框在下半屏中央。抓取前后各回此位姿拍一帧。
    _VERIFY_POSE = (0.0, 12.0, 12.0, -40.0)
    # 物体搜索窗(占画面比例 x0,y0,x1,y1):收紧到桌面正中央——只有待抓物体
    # 会在此区,排除左下键盘/右侧书柜/左侧 LED 等更大的亮背景块。
    # (真机标定:插头落在中央;物体移出此窗则 before 检不到→自判弃权)
    _WHITE_ROI = (0.40, 0.22, 0.66, 0.56)
    # 同区域白色存活率:抓取后回校验位,若物体所在 ROI 亮白像素跌到战前
    # 此比例以下 → 物体已被抬离桌面 → 判为夹住;否则还在原位 → 未夹住。
    _WHITE_KEEP_RATIO = 0.5
    # 物体"仍在原位"判据:抓取后同带内若存在一个质心偏移 <= 此像素且面积
    # >= 战前 _WHITE_KEEP_RATIO 倍白块 → 物体未动(未夹住);否则视为被抬走。
    _OBJ_STAY_DIST = 55

    def _ik_to(self, x, y, z, pitch=0.0, movetime_ms=1500, box=None):
        """内部:限幅到 box 后调厂商 ArmIK 把末端摆到 (x,y,z)cm(绝不动车轮)。
        返回 {ok, dryRun, found, eff, pitch, servos, error};eff 为限幅后的实际坐标。
        无解不抛错,以 found=false 如实回报(供 press/grasp 逐段判定)。"""
        box = box or self._IK_BOX
        x = max(-box["xAbs"], min(box["xAbs"], float(x)))
        y = max(box["yMin"], min(box["yMax"], float(y)))
        z = max(box["zMin"], min(box["zMax"], float(z)))
        pitch = max(-90.0, min(90.0, float(pitch)))
        movetime_ms = max(200, min(3000, int(movetime_ms)))
        eff = [round(x, 1), round(y, 1), round(z, 1)]
        if self.dry_run:
            return {"ok": True, "dryRun": True, "found": True, "eff": eff, "pitch": pitch}
        if not self._hw():
            return {"ok": False, "eff": eff, "error": "hardware unavailable"}
        try:
            if self._kin_root not in sys.path:
                sys.path.insert(0, self._kin_root)
            from kinematics.arm_move_ik import ArmIK
            ak = ArmIK()
            ak.board = self._board  # 复用共享 board,避免二次占用串口
            res = ak.setPitchRangeMoving((x, y, z), pitch, -90, 90, movetime_ms)
            if res is False:
                log.warning("[REAL] arm.ik no solution for eff=%s", eff)
                return {"ok": True, "dryRun": False, "found": False, "eff": eff,
                        "error": "no IK solution for target"}
            servos, alpha, mt = res
            log.info("[REAL] arm.ik eff=%s -> servos=%s", eff, servos)
            return {"ok": True, "dryRun": False, "found": True, "eff": eff,
                    "pitch": round(float(alpha), 1), "servos": servos, "movetime_ms": mt}
        except Exception as e:
            log.exception("arm.ik failed")
            return {"ok": False, "eff": eff, "error": repr(e)}

    def _gripper(self, pulse, travel_sec=0.5):
        """夹爪 servo1 控制:pulse 1500(夹紧)~2000(全开)。绝不动车轮。
        pwm_servo_set_position 非阻塞,故下发后 sleep 到行程结束再返回。"""
        pulse = int(max(1000, min(2000, int(pulse))))
        if self.dry_run:
            return {"ok": True, "dryRun": True, "action": "gripper", "pulse": pulse}
        if not self._hw():
            return {"ok": False, "error": "hardware unavailable"}
        try:
            self._board.pwm_servo_set_position(float(travel_sec), [[1, pulse]])
            time.sleep(travel_sec + 0.2)
            log.info("[REAL] gripper pulse=%s", pulse)
            return {"ok": True, "dryRun": False, "action": "gripper", "pulse": pulse}
        except Exception as e:
            return {"ok": False, "action": "gripper", "error": repr(e)}

    # ---------------- 视觉自校验:本机无夹持/力反馈,改用"桌上物体是否被抬走"判夹没夹到 ----------------
    def _grab_frame(self, timeout=6.0):
        """向 8110 预览流借一帧(不自己开相机,避免与预览抢相机)。
        返回 BGR ndarray 或 None。"""
        if self.dry_run or not self._hw():
            return None
        try:
            import urllib.request
            import cv2
            import numpy as np
            url = self.stream_url.rstrip("/") + "/shot"
            data = urllib.request.urlopen(url, timeout=timeout).read()
            frame = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                return None
            # 预览流无相机帧时会回一张几乎全黑的"no frame (retrying)"占位图,
            # 它能被解码但不是真画面;按均亮度地板过滤,避免被当成"物体消失"。
            if float(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean()) < 15.0:
                log.debug("grab_frame got near-black placeholder, treat as no-frame")
                return None
            return frame
        except Exception as e:
            log.warning("grab_frame from stream failed: %r", e)
            return None

    def _white_mask(self, frame):
        """按厂商白色 LAB 阈值(L>=193)二值化 + 开运算去噪。"""
        import cv2
        lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
        m = cv2.inRange(lab, (193, 0, 0), (255, 255, 255))
        return cv2.morphologyEx(m, cv2.MORPH_OPEN,
                                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))

    def _find_object_blob(self, frame, min_area=800):
        """在桌面可达中央区带(_WHITE_ROI)内找最大亮白连通域(即待抓物体)。
        带区过滤排除左下键盘/顶部书柜等亮背景。返回 {area,cx,cy,box} 或 None。"""
        import cv2
        import numpy as np
        if frame is None:
            return None
        m = self._white_mask(frame)
        h, w = m.shape[:2]
        rx0, ry0, rx1, ry1 = self._WHITE_ROI
        x0, y0 = int(w * rx0), int(h * ry0)
        x1, y1 = int(w * rx1), int(h * ry1)
        roi = np.zeros_like(m)
        roi[y0:y1, x0:x1] = m[y0:y1, x0:x1]
        n, _labels, stats, cents = cv2.connectedComponentsWithStats(roi, 8)
        best = None
        for i in range(1, n):
            a = int(stats[i, cv2.CC_STAT_AREA])
            if a < min_area:
                continue
            if best is None or a > best["area"]:
                best = {"area": a, "cx": int(cents[i][0]), "cy": int(cents[i][1]),
                        "box": [int(stats[i, 0]), int(stats[i, 1]),
                                int(stats[i, 2]), int(stats[i, 3])]}
        return best

    def _verify_pose(self):
        """把臂摆到标定好的校验机位(头部相机能框到桌面抓取区)并等停稳+流刷新。
        开环底座回转在大跨度抓取后需较长时间回到完全相同机位;实测 1.6s 不足
        会拍到机位漂移帧(物体暂时漂出窗→假阳性),故停稳 2.8s 再拍。"""
        vx, vy, vz, vp = self._VERIFY_POSE
        self._ik_to(vx, vy, vz, vp, 1200, self._IK_BOX)
        time.sleep(2.8)

    def _object_blob_stable(self, k=3, gap=0.45):
        """连续拍 k 帧找待抓物体白块,取质心一致性投票。
        返回 (blob_or_None, frames_ok):frames_ok=成功解码的帧数。
        区分"取帧失败(frames_ok=0)"与"拍到但窗内无白块(blob=None,frames_ok>0)"——
        前者必须弃权,不能被当成"物体被夹走"误判为夹住。瞬时光斑不会连续出现。"""
        blobs = []
        frames_ok = 0
        for _ in range(k):
            f = self._grab_frame()
            if f is not None:
                frames_ok += 1
                b = self._find_object_blob(f)
                if b is not None:
                    blobs.append(b)
            if gap:
                time.sleep(gap)
        if frames_ok == 0:
            return None, 0
        if not blobs:
            return None, frames_ok
        xs = sorted(b["cx"] for b in blobs)
        ys = sorted(b["cy"] for b in blobs)
        mx = xs[len(xs) // 2]; my = ys[len(ys) // 2]
        support = [b for b in blobs
                   if ((b["cx"] - mx) ** 2 + (b["cy"] - my) ** 2) ** 0.5 <= self._OBJ_STAY_DIST]
        if len(support) < max(2, (len(blobs) + 1) // 2):
            return None, frames_ok
        return max(support, key=lambda b: b["area"]), frames_ok

    def gripper(self, pulse=1800, action=None, travel_sec=0.5):
        """夹爪独立控制(示教/调试用):action=open/close/half 覆盖 pulse,
        否则按裸 pulse(1000~2000)。绝不动车轮。
        注:本机全身为开环 PWM 舵机,pwm_servo_read_position 只回显 PCA9685
        输出寄存器(=命令值),不是真实轴位,故不提供回读判据(会误事)。"""
        preset = {"open": self._GRIP_OPEN, "close": self._GRIP_CLOSE,
                  "half": self._GRIP_RELEASE}
        if action in preset:
            pulse = preset[action]
        r = self._gripper(pulse, travel_sec)
        r["action"] = "gripper"
        return r

    # ---------------- 机械臂逆运动学:坐标摆放(不动车;安全盒限位) ----------------
    def arm_ik(self, x, y, z, pitch=0.0, movetime_ms=1500):
        """用运动学把末端摆到 (x,y,z)cm(机械臂可动,绝不动车轮)。
        坐标硬限幅到默认安全盒内;无解返回 found=false。"""
        r = self._ik_to(x, y, z, pitch, movetime_ms, self._IK_BOX)
        params = {"xyz_cm": r.get("eff"), "pitch": r.get("pitch", pitch),
                  "movetime_ms": max(200, min(3000, int(movetime_ms)))}
        if self.dry_run:
            return self._dry("arm.ik", params)
        out = {"ok": r.get("ok", False), "dryRun": False, "action": "arm.ik",
               "params": params, "found": r.get("found")}
        if r.get("found"):
            out["pitch"] = r.get("pitch")
        if r.get("error"):
            out["error"] = r.get("error")
        return out

    # ---------------- 抓取宏:抬臂→张开→(拍前帧)→上方→下探→闭合→抬起→(拍后帧自判) ----------------
    def grasp(self, x, y, z, pitch=0.0, hover_cm=4.0, lift_cm=6.0,
              grip_travel=0.5, movetime_ms=1200, home=True, verify=True):
        """手喂坐标抓取宏(绝不动车轮):把夹爪送到物体抓取点并合爪拾起。
        (x,y,z)cm 为物体处夹爪应到达的抓取点(机体系,z 为抓取高度);
        用放宽的抓取安全盒。建议 pitch=-90(夹爪竖直朝下)。
        verify=True 时启用视觉自判(本机无夹持/力反馈的唯一可靠反馈途径):
        先把臂摆到校验机位拍一帧锁定桌上白色物体区域,完成抓取抬起后
        回到同一机位再拍一帧——若该区域亮白消失(物体被抬离桌面)判为夹住,
        否则未夹住;返回 grasped 布尔值与存活率等量化证据。物体不可见/非白色
        时无法自判,grasped 退回 None 并说明原因。任一环节无解即中止。dryRun 只出计划。"""
        hover_cm = max(1.0, min(12.0, float(hover_cm)))
        lift_cm = max(2.0, min(18.0, float(lift_cm)))
        movetime_ms = max(200, min(3000, int(movetime_ms)))
        params = {"target_cm": [float(x), float(y), float(z)], "pitch": pitch,
                  "hover_cm": hover_cm, "lift_cm": lift_cm, "movetime_ms": movetime_ms}
        trail = []

        def _pause():
            if not self.dry_run:
                time.sleep(max(0.1, movetime_ms / 1000.0))

        def _fail(step_name, res):
            trail.append({"step": step_name, "ok": res.get("ok"),
                          "eff": res.get("eff"), "found": res.get("found"),
                          "pulse": res.get("pulse")})
            return {"ok": False, "action": "arm.grasp", "params": params, "steps": trail,
                    "failed": step_name, "error": res.get("error") or ("no IK for " + step_name)}

        def _move(step_name, mx, my, mz):
            res = self._ik_to(mx, my, mz, pitch, movetime_ms, self._GRASP_BOX)
            trail.append({"step": step_name, "ok": res.get("ok"), "eff": res.get("eff"),
                          "found": res.get("found"), "pitch": res.get("pitch")})
            if res.get("ok") is False or (res.get("found") is False and not self.dry_run):
                return False
            _pause()
            return True

        # 1) 可选先回厂商安全抬臂位,避免横扫到桌面障碍
        if home and not _move("lift_home", 0, 6, 18):
            trail[-1]["failed"] = True
            return {"ok": False, "action": "arm.grasp", "params": params, "steps": trail,
                    "failed": "lift_home",
                    "error": trail[-1].get("error") or "no IK for lift_home"}
        # 2) 张开夹爪
        r = self._gripper(self._GRIP_OPEN, grip_travel)
        if r.get("ok") is False:
            return _fail("open", r)
        trail.append({"step": "open", "ok": True, "pulse": r.get("pulse")})

        # 2b) 视觉自判:回校验机位拍"抓取前"帧,锁定桌上物体区域
        vobj = None
        verify_info = {"enabled": bool(verify)}
        if verify and not self.dry_run and self._hw():
            self._verify_pose()
            blob, bok = self._object_blob_stable()
            verify_info["before_frames"] = bok
            if blob is not None:
                vobj = {"cx": blob["cx"], "cy": blob["cy"], "area": blob["area"],
                        "box": blob["box"]}
                verify_info["before"] = {"centroid": [blob["cx"], blob["cy"]],
                                          "area": blob["area"], "box": blob["box"]}
            else:
                verify_info["before"] = None

        # 3) 移到目标正上方
        if not _move("above", x, y, float(z) + hover_cm):
            return _fail("above", {"error": trail[-1].get("error")})
        # 4) 下探到抓取高度
        if not _move("descend", x, y, z):
            return _fail("descend", {"error": trail[-1].get("error")})
        # 5) 合爪抓取(开环无反馈)
        r = self._gripper(self._GRIP_CLOSE, grip_travel)
        if r.get("ok") is False:
            return _fail("close", r)
        trail.append({"step": "close", "ok": True, "pulse": r.get("pulse")})
        # 6) 抬起(带物体)
        if not _move("lift", x, y, float(z) + lift_cm):
            return _fail("lift", {"error": trail[-1].get("error")})

        # 6b) 视觉自判:回同一校验机位再拍一帧。若同带内物体仍在原位附近
        # (质心偏移<=_OBJ_STAY_DIST 且面积>=战前_RATIO) → 未夹住;否则被抬走 → 夹住。
        grasped = None
        if verify and vobj is not None:
            self._verify_pose()
            ab, aok = self._object_blob_stable()
            verify_info["after_frames"] = aok
            if aok == 0:
                grasped = None  # 取帧失败,无法判断→弃权(不谎报)
                verify_info["after"] = {"capture_failed": True}
            elif ab is None:
                grasped = True  # 拍到了但窗内已无物体白块 → 被抬离桌面/出视野
                verify_info["after"] = {"blob": None}
            else:
                stay = ((ab["cx"] - vobj["cx"]) ** 2 + (ab["cy"] - vobj["cy"]) ** 2) ** 0.5
                still_there = (stay <= self._OBJ_STAY_DIST
                               and ab["area"] >= self._WHITE_KEEP_RATIO * vobj["area"])
                grasped = not still_there
                verify_info["after"] = {"centroid": [ab["cx"], ab["cy"]], "area": ab["area"],
                                        "shift_px": round(stay, 1),
                                        "stay_dist": self._OBJ_STAY_DIST}
        elif verify:
            verify_info["reason"] = "object not visible at verify pose (or dryRun/no-hw)"

        log.info("[REAL] arm.grasp %s grasped=%s verify=%s steps=%s",
                 params, grasped, verify_info, trail)
        out = {"ok": True, "dryRun": self.dry_run, "action": "arm.grasp",
               "params": params, "steps": trail, "grasped": grasped,
               "verify": verify_info}
        if grasped is None:
            out["note"] = "no grip feedback; visual verify unavailable/undecided, check frame"
        return out


    # ---------------- 点按探测:悬停→下压→抬起(三段 IK,不动车轮) ----------------
    def press(self, x, y, z, pitch=0.0, hover_cm=3.0, hold_ms=250, movetime_ms=1200):
        """用逆运动学做一次"点按":先悬停到接触点上方,再下压到接触点,停顿后抬起回悬停位。
        坐标 (x,y,z)cm 是机械臂基座系,由调用方手动给出(不含视觉解算),仅用于探测真实定位精度。
        三段各走 arm_ik(自动限幅到安全盒 + 无解判定),任一段失败即中止并如实返回失败段与
        各段实际(限幅后)坐标,便于据实判断能否稳定命中目标。绝不动车轮。"""
        hover_cm = max(0.5, min(10.0, float(hover_cm)))
        hold_ms = max(0, min(2000, int(hold_ms)))
        movetime_ms = max(200, min(3000, int(movetime_ms)))
        params = {"contact_cm": [float(x), float(y), float(z)], "pitch": pitch,
                  "hover_cm": hover_cm, "hold_ms": hold_ms, "movetime_ms": movetime_ms}
        if self.dry_run:
            return self._dry("arm.press", params)
        # 逐段交给 arm_ik:它会做硬限幅、限时无解判定,并回传实际(clamped)坐标
        segments = [
            ("approach", x, y, float(z) + hover_cm),  # 接触点上方悬停
            ("press", x, y, z),                       # 下压到接触点
            ("release", x, y, float(z) + hover_cm),   # 抬起回悬停位
        ]
        trail = []
        for name, sx, sy, sz in segments:
            r = self.arm_ik(sx, sy, sz, pitch, movetime_ms)
            eff = (r.get("params") or {}).get("xyz_cm")
            trail.append({"seg": name, "eff_cm": eff, "found": r.get("found")})
            if r.get("ok") is False:
                return {"ok": False, "action": "arm.press", "params": params,
                        "segments": trail, "failed": name, "error": r.get("error")}
            if r.get("found") is False:
                return {"ok": False, "action": "arm.press", "params": params,
                        "segments": trail, "failed": name,
                        "error": "no IK solution for %s segment" % name}
            # setPitchRangeMoving 非阻塞:等机械臂到位再走下一段;下压段额外按住 hold_ms
            time.sleep(max(0.1, movetime_ms / 1000.0))
            if name == "press" and hold_ms:
                time.sleep(hold_ms / 1000.0)
        log.info("[REAL] arm.press %s segments=%s", params, trail)
        return {"ok": True, "dryRun": False, "action": "arm.press",
                "params": params, "segments": trail}

    # ---------------- 视觉:颜色识别 / 抓拍(纯相机,不动车) ----------------
    def color_detect(self, timeout_sec=2.0):
        import vision
        timeout_sec = max(0.5, min(5.0, float(timeout_sec)))
        params = {"timeout_sec": timeout_sec, "camera": self.camera_device}
        if self.dry_run:
            return self._dry("vision.color_detect", params)
        try:
            return vision.detect_colors(camera=self.camera_device,
                                        lab_file=self._lab_file, timeout_sec=timeout_sec)
        except Exception as e:
            log.exception("color_detect failed")
            return {"ok": False, "action": "vision.color_detect", "error": repr(e)}

    def camera_snapshot(self):
        import vision
        params = {"camera": self.camera_device}
        if self.dry_run:
            return self._dry("camera.snapshot", params)
        try:
            return vision.snapshot(camera=self.camera_device)
        except Exception as e:
            log.exception("camera_snapshot failed")
            return {"ok": False, "action": "camera.snapshot", "error": repr(e)}

    # ---------------- 待接线挂点(pick/place/photo/music:依赖视觉/音频,留后续) ----------------
    def pick(self, target):
        return self._pending("arm.pick", {"target": str(target)})

    def place(self, target):
        return self._pending("arm.place", {"target": str(target)})

    def take_photo(self):
        return self._pending("camera.take_photo", {})

    def play_music(self, keyword):
        return self._pending("player.play_music", {"keyword": str(keyword)})

    def stop_music(self):
        return self._pending("player.stop_music", {})
