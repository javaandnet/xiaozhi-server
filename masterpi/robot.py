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
        # (deg, angular):forward=90 后退=270 左平移=180 右平移=0 左原地转=-1 右原地转=+1
        mapping = {"forward": (90, 0), "backward": (270, 0),
                   "left": (180, 0), "right": (0, 0),
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
                self._chassis.reset_motors()
                log.info("[REAL] chassis.stop")
                return {"ok": True, "dryRun": False, "action": "chassis.stop"}
            deg, ang = mapping[direction]
            self._chassis.set_velocity(velocity, deg, ang)
            time.sleep(duration_sec)
            log.info("[REAL] chassis.drive %s", params)
            return {"ok": True, "dryRun": False, "action": "chassis.drive", "params": params}
        except Exception as e:
            return {"ok": False, "error": repr(e)}
        finally:
            self._chassis.reset_motors()  # 无论如何都收油,安全兜底

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
            self._board.pwm_servo_set_position(0.35, [[3, s3], [6, s6]])
            log.info("[REAL] vision.face_align action=%s s3=%s s6=%s", action, s3, s6)
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

    # ---------------- 机械臂逆运动学:坐标摆放(不动车;安全盒限位) ----------------
    def arm_ik(self, x, y, z, pitch=0.0, movetime_ms=1500):
        """用运动学把末端摆到 (x,y,z)cm(机械臂可动,绝不动车轮)。
        坐标硬限幅到安全盒内;无解返回 found=false。"""
        # 安全边界盒(单位 cm):超出即钉回,避免指令把臂撞坏
        x = max(-12.0, min(12.0, float(x)))
        y = max(0.0, min(16.0, float(y)))
        z = max(4.0, min(30.0, float(z)))
        pitch = max(-90.0, min(90.0, float(pitch)))
        movetime_ms = max(200, min(3000, int(movetime_ms)))
        params = {"xyz_cm": [x, y, z], "pitch": pitch, "movetime_ms": movetime_ms}
        if self.dry_run:
            return self._dry("arm.ik", params)
        if not self._hw():
            return {"ok": False, "error": "hardware unavailable"}
        try:
            if self._kin_root not in sys.path:
                sys.path.insert(0, self._kin_root)
            from kinematics.arm_move_ik import ArmIK
            ak = ArmIK()
            ak.board = self._board  # 复用共享 board,避免二次占用串口
            res = ak.setPitchRangeMoving((x, y, z), pitch, -90, 90, movetime_ms)
            if res is False:
                log.warning("[REAL] arm.ik no solution for %s", params)
                return {"ok": True, "dryRun": False, "action": "arm.ik",
                        "params": params, "found": False,
                        "error": "no IK solution for target"}
            servos, alpha, mt = res
            log.info("[REAL] arm.ik %s -> servos=%s", params, servos)
            return {"ok": True, "dryRun": False, "action": "arm.ik",
                    "params": params, "found": True, "pitch": alpha}
        except Exception as e:
            log.exception("arm.ik failed")
            return {"ok": False, "action": "arm.ik", "error": repr(e)}

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
