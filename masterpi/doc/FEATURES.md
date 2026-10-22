# MasterPi 官方功能面与本项目接线总览

> 派端(192.168.1.91)厂商 SDK 位于 `~/MasterPi/`。本文件整理官方提供的全部能力示例、安全分级（底盘红线），
> 以及本项目 `masterpi_client` 已接线/未接线对照，便于后续按需调用。
> 派上无独立 README/PDF，官方"文档"即 `~/MasterPi/command` 命令清单 + 各脚本中英注释 + PC 上位机。
> 代码真源：`masterpi/tools.py`（MCP schema）、`masterpi/robot.py`（动作实现）、`masterpi/vision.py`（视觉）。

## 一、安全红线（贯穿全部）

- `robot.allowChassis=false`：**绝不碰麦轮底盘**。机器常放桌上，一动有坠落风险；如需动底盘须用户明确许可。
- 官方多个"视觉玩法"示例**默认靠开车轮**去跟随/巡线/避障（见下），直接搬用会违反红线——本项目一律不用这类，改走"只动 s6/s3 云台 + 纯相机"的等价实现。
- **供电（可靠性红线）**：本机为 **Raspberry Pi 5**，必须用**官方 27W 5.1V/5A USB-C PD/PPS 电源 + 短粗好线**。相机+舵机+WiFi+CV2/SFace 推理的电流尖峰会把 5V 拉垮→**欠压硬断电**（`journalctl -k` 见 `Undervoltage detected!`，红灯常亮=有电但已死机/闪烁=实时欠压）。普通 5V/3A（15W）头（含只标 45W 但 5V 档仅 3A 的 PD 头）**带不动 MasterPi**。已配 `kernel.panic=10`（死机自动重启）+ `masterpi-client` systemd `Restart=always`，但**欠压断电属整机失电，软件救不回，必须换电源**。

## 二、官方功能面（按 SDK 目录）

### A. `functions/`（视觉/行为示例，`rpc_server.py` 也按同名暴露 RPC）

| 功能 | 文件 | 执行器 | 红线 | 本项目 |
|---|---|---|:---:|---|
| 颜色识别 | `color_detect.py` | 纯相机 | ✅ 安全 | ✅ 已接线 `robot_color_detect` |
| 颜色分拣（臂抓色块） | `color_sorting.py` | 相机+**机械臂** | ✅ 安全(臂可动) | ⏳ 未做（组合 pick/place+IK，工程量大） |
| 目标追踪 | `color_tracking.py` | **麦轮 PID 跟随** + s1 躯干 | ❌ 动车轮 | ⛔ 不做（违反红线；如需无轮追踪另用 s6/s3 改造） |
| 智能巡线 | `visual_patrol.py` | 相机+**麦轮** | ❌ 动车轮 | ⛔ 不做 |
| 智能避障 | `avoidance.py` | 超声+**麦轮** | ❌ 动车轮 | ⛔ 不做 |
| LAB 颜色标定 | `lab_adjust.py` | 相机 | ✅ 安全 | （调 `lab_config.yaml`，`color_detect` 直接复用该表） |

### B. `board_demo/` + `kinematics_sdk/`（板级/运动学）

- `control_by_servo.py` — 原始 PWM 舵机（本项目 `arm_pose` 微动作/对准在用）。
- `control_by_kinematics.py` / `kinematics/arm_move_ik.py::ArmIK` — **机械臂逆运动学**：末端摆到 (x,y,z)cm。
  - `ArmIK.__init__` **不**自建 board，`servosMove` 用 `self.board` → 由调用方注入；本项目 `robot.arm_ik` 里 `ak.board = self._board` **复用共享串口**，不二次占用 `/dev/ttyAMA0`。
  - ✅ 已接线 `robot_arm_ik`（坐标硬限幅到安全盒 x[-12,12]/y[0,16]/z[4,30]）。
- `hardware_test.py` — 电机+臂自检（含底盘，红线内不自动化）。

### C. `masterpi_sdk/common_sdk/common/`（原语库）

- `ros_robot_controller_sdk.py::Board` — 串口总控：`pwm_servo_set_position`、`set_buzzer`、`set_rgb`、`get_battery`、`get_imu`、`set_motor_speed`(底盘) 等。
  - ✅ `get_battery` → `robot_get_battery`（raw 约 mV，实测 ~5007→5.0V）。
  - ✅ `set_rgb([[1,r,g,b],[2,r,g,b]])` → `robot_set_rgb`（厂商 RGB 走**此串口路径**，非 I2C）。
- `sonar.py::Sonar` — I2C(0x77) 超声波+两盏 RGB 模块：`getDistance()`、`setPixelColor/setRGBMode/setBreathCycle`。
  - ⚠️ 测距 `robot_get_distance` 用它；**本机 bus1 `i2cdetect` 全空（0x77 不在）→ 该模块未接**，工具优雅返回 `clear=false`。接上模块后即可用。
  - RGB 不用这条 I2C（改走串口 C）。
- `action_group_control.py` — 动作组（`arm_pose` 的 greet/nod/shake… 在用）。
- `pid.py` — PID（官方麦轮跟随用，本项目不用）。
- `mecanum.py` — 麦轮底盘封装（`_hw()` 靠它建共享 board，但**底盘方法不调**）。

### D. 视频流 / 上位机

- `mjpg_server.py` — 标准 MJPEG HTTP 视频流（`http://<pi>:8080?action=stream`，`/?action=snapshot` 单帧）。
  - 本项目暂未起该服务；如需在 studio 内看机器人实时画面，可后续把它 systemd 常驻 + studio 内嵌 `<img>`（非工具，纯服务）。
- `masterpi_pc_software/` — PC 端图形化上位机（`Arm.py`），仅供厂商手动调试，非服务端能力。

## 三、本项目 MCP 工具总览（`masterpi/tools.py`，23 个）

- 身体/动作：`robot_arm_pose`(11 语义动作) · `robot_arm_ik`(坐标摆放) · `robot_beep` · `robot_face_align`(相机云台 s3 俯仰/s6 水平微调，**studio 登记向导直调**，只动云台绝不碰轮子)
- 感知/问答：`robot_search_face`(巡视+对准+识人，命中报 `person`/`person_id` 并上报 `face_found` 事件) · `robot_face_enroll`(引导式登记) · `robot_face_recognize`(单次识人) · `robot_face_list` · `robot_face_rename`(改 ID/称呼) · `robot_face_login`(人脸登录) · `robot_face_logout` · `robot_face_delete` · `robot_color_detect` · `robot_camera_snapshot` · `robot_take_photo`(挂起)
- 传感器：`robot_get_battery` · `robot_get_distance`(需接 I2C 模块)
- 灯光：`robot_set_rgb`(串口)
- 底盘：`robot_drive`（红线默认拒绝）
- 未接线挂点：`robot_pick` · `robot_place` · `robot_play_music` · `robot_stop_music`（真机如实返回未实现）

> 人脸能力栈（均 cv2 contrib 内置，零额外依赖）：检测 YuNet（`models/face_detection_yunet_2023mar.onnx`，输出含 5 关键点）→ 对齐+嵌入 SFace（`models/face_recognition_sface_2021dec.onnx`，`cv2.FaceRecognizerSF`，128 维 L2 归一）→ 比对人脸库 `faces.json`（`face_db.py`，余弦距离阈值 0.363 可配 `config.json robot.vision.recogThreshold`，每人最多 5 样本，多数表决）；预览流 `vision_stream.py` 在**干净帧（画框前）**算 embed 随 `/frames` 下发，登记/识人均与预览共存。
>
> 库结构（schema v2）：成员以自动生成的稳定 **ID**（`p_xxxxxx`）为主键存储，**称呼**（name）为展示/播报用，两者均可改且全局查重（大小写不敏感）；v1（以 name 为键）旧库首次 `load_db` 时自动迁移为 v2 并落盘。`current_login` 字段记录“当前登录人”（`robot_face_login` 扫脸命中后写入，随 ID 重命名迁移、随删除同步登出）；**人脸登录为默认关闭能力**，受开关 `config.json robot.vision.faceLoginEnabled`（缺省 false）控制，`robot_face_login` 在未开启时优雅拒绝。studio「👤 人脸库」卡片：列表/编辑(ID+称呼)/删除/阈值/登录开关走 SSH 直调 `face_db.py` CLI（`list|rename|delete|threshold|facelogin`），登记/人脸登录/退出走 `/api/mcp/call`（`robot_face_enroll`/`robot_face_login`/`robot_face_logout`）。
>
> studio 人脸库交互细化：**「📷 引导登记向导」**弹窗提供分步教程（1 对准→2 取名→3 采集→4 完成）+ **窗口内实时画面**（复用 `vision_stream` 预览流）+ 第一步的**云台微调按钮 ↑仰起/↓低头/←/→/◎回正**（直调 `robot_face_align`，登记前先框正脸）；同一向导支持**「➕ 追加样本」**模式（锁定目标 ID，采集时带 `id` 后端合并进该人、近重复去重、每人上限 5）；**「✏️ 编辑」**为单弹窗内 **ID 与称呼一起改**（非两步 prompt）。`robot_face_align` 仅由 studio 直调，**不注入大模型语音动作目录**（`robotActions.js` 保持 22 项）。

> 分类与"动作后是否极短确认"的判定见 `core/services/robotActions.js` 与 `doc/使用说明.md` 第 8 节（动作目录已并入该总文档）：
> `category ∉ {vision, sensor}` 视为纯动作（成功后只补一句确认），感知/传感查询仍走二轮 LLM 把结果读出。

## 四、单独跑厂商示例（派上直连，走 `~/MasterPi/command`）

```
python3 ~/MasterPi/functions/color_detect.py        # 颜色识别（含臂动作，注意别放桌上乱动）
python3 ~/MasterPi/board_demo/control_by_servo.py   # 原始舵机控制
```

底盘类（`mecanum_control/*`、`avoidance`、`visual_patrol`、`color_tracking`、`running`、`remote_control`）**本项目禁止自动化调用**——会驱动车轮。
