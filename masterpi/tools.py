"""
MasterPi 对外上报的 MCP 工具清单(语义宏,禁止暴露原始关节/坐标)。

TOOLS: 符合 MCP tools/list 的 schema(name/description/inputSchema),
description 用中文,提升本地 LLM 命中与选参准确率。
DISPATCH: 工具名 -> Robot 方法映射。
"""

import logging
import threading

from robot import ARM_POSES

log = logging.getLogger("masterpi.tools")

TOOLS = [
    {
        "name": "robot.drive",
        "description": "控制机器人底盘移动。direction 取值:forward/backward/left/right/turn_left/turn_right/stop;duration_sec 为移动时长(秒,0~5);speed 为速度(0~0.5)。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["forward", "backward", "left", "right", "turn_left", "turn_right", "stop"]},
                "duration_sec": {"type": "number", "description": "移动时长,秒,范围 0~5,默认 1"},
                "speed": {"type": "number", "description": "速度,范围 0~0.5,默认 0.3"},
            },
            "required": ["direction"],
        },
    },
    {
        "name": "robot.arm_pose",
        "description": "让机械臂做一个语义动作。pose 取值:reset(归位站立)/greet 或 thanks(打招呼/致谢)/wave(挥手)/reach_left 或 reach_right(向前伸左右)/nod(点头)/shake(摇头)/bow(鞠躬)/raise_right(举手)/dance(短舞)。这些都是机器人预置的安全动作宏,调用方只给语义名,不给关节角度。",
        "inputSchema": {
            "type": "object",
            "properties": {"pose": {"type": "string", "enum": ARM_POSES}},
            "required": ["pose"],
        },
    },
    {
        "name": "robot.pick",
        "description": "抓取一个物体。target 是语义标识,例如 '红色方块'、'杯子'、'桌上的苹果'。坐标由机器人本地视觉解算,调用方只给语义目标。",
        "inputSchema": {
            "type": "object",
            "properties": {"target": {"type": "string", "description": "要抓取物体的语义描述"}},
            "required": ["target"],
        },
    },
    {
        "name": "robot.place",
        "description": "把当前抓取的物体放到目标位置。target 是语义标识,例如 '盒子里'、'桌子上'。",
        "inputSchema": {
            "type": "object",
            "properties": {"target": {"type": "string", "description": "放置位置的语义描述"}},
            "required": ["target"],
        },
    },
    {
        "name": "robot.take_photo",
        "description": "用云台摄像头拍一张照片,用于识别/问答场景(例如'看看这是什么')。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "robot.search_face",
        "description": "转动头部和躯干(不移动轮子)用摄像头搜寻人脸:上下左右巡视,找到后立即停止并开环扫描把头部(水平)/颈部(垂直)对准人脸、拉到画面正中,同时蜂鸣提示;对准后会识人(比对已登记的人脸库),返回 found=true 与 person(已登记则是该姓名,陌生人/未登记为 null);找不到返回 found=false。并向服务器上报 face_found 事件由服务器统一调度播报。用于用户说'找找我在哪''看看周围有没有人''认出是谁'等场景。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "max_scan_sec": {"type": "number", "description": "扫描时间上限,秒,5~25,默认 20"},
            },
            "required": [],
        },
    },
    {
        "name": "robot.face_enroll",
        "description": "把一个人登记到人脸库(用于以后'认出是谁')。name 是称呼(如姓名,库内不可重复);id 可选,不填自动生成 p_xxxxxx 的稳定编号(也可手填自定义编号,重复则拒绝)。机器人会先把脸对准到画面正中(必要时自动扫描寻脸),再多帧采集面部特征入库。需要被登记者在镜头里、正面、保持不动。预览开着时也可登记(自动借帧)。绝不碰轮子。用于'记住这个人''登记 xxx'等场景。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "人的称呼/姓名,如 'fengleiren';库内不可重复"},
                "id": {"type": "string", "description": "可选稳定编号(p_开头小写字母数字,不填则自动生成);与已有 ID 重复会被拒绝"},
                "frames": {"type": "number", "description": "采集帧数,3~8,默认 5"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "robot.face_recognize",
        "description": "只看当前画面认出是谁(不扫描不转身,耗时短):取几帧比对人脸库,返回 person(已登记姓名,陌生/未匹配为 null)。用于'看看眼前这个人是谁''你知道他是谁吗'等场景。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "robot.face_list",
        "description": "列出已登记的人脸库成员(ID/称呼/样本数/登记时间)及当前登录人(不运动)。用于'你们都认识谁''人脸库里有哪些人''现在登录的是谁'等场景。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "robot.face_delete",
        "description": "从人脸库删除某个已登记成员,按 ID 或称呼定位(不运动)。用于'忘掉那个人''把 xxx 从人脸库删掉'等场景。",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "要删除的 ID 或称呼"}},
            "required": ["name"],
        },
    },
    {
        "name": "robot.face_rename",
        "description": "修改已登记成员的 ID 或称呼(不运动):按现有 ID/称呼定位,新 ID/新称呼均查重(大小写不敏感)。用于'把 xxx 改叫 yyy''把他的编号改成 p_ab12'等场景。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "现有成员的 ID 或称呼"},
                "id": {"type": "string", "description": "新 ID(可选,p_开头;不填不改)"},
                "name": {"type": "string", "description": "新称呼(可选;不填不改)"},
            },
            "required": ["key"],
        },
    },
    {
        "name": "robot.face_login",
        "description": "人脸识别登录:看当前画面识人(不扫描不转身),认出已登记成员则把他记为'当前登录人'(后续问答/播报可参照)。此功能默认关闭(需先在人脸库设置里打开开关 faceLoginEnabled);未开启时调用会返回'未开启'。陌生/未登记脸登录失败。用于'我要登录''用脸登录'。配套 robot.face_logout 退出。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "robot.face_logout",
        "description": "退出登录(清除人脸库的当前登录人,不运动)。用于'退出登录''登出'。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "robot.face_align",
        "description": "手动微调相机云台做取景对齐(只动俯仰 s3/水平 s6,绝不碰轮子与躯干):action=up/down 上下调俯仰(仰起为正),left/right 左右调水平,center 回中位;step 为每次增量(默认100)。用于登记前把画面正对入要登记者的脸。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["up", "down", "left", "right", "center"], "description": "调整方向"},
                "step": {"type": "integer", "description": "每次舵机增量(可选,20~400,默认100)"},
            },
            "required": ["action"],
        },
    },
    {
        "name": "robot.play_music",
        "description": "播放歌曲。keyword 是歌名/歌手等搜索词,例如 '晴天 周杰伦'。",
        "inputSchema": {
            "type": "object",
            "properties": {"keyword": {"type": "string", "description": "点歌关键词"}},
            "required": ["keyword"],
        },
    },
    {
        "name": "robot.stop_music",
        "description": "停止当前播放的音乐。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "robot.beep",
        "description": "让机器人发出一声提示音(beep)。用于链路验证。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "robot.get_battery",
        "description": "读取机器人电池电压/电量状态(不运动)。用于'还有多少电''电量够不够'等场景。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "robot.get_distance",
        "description": "用超声波测机器人前方障碍物的距离(不动车),返回厘米。用于'前面有东西吗''离墙多远'等场景。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "robot.set_rgb",
        "description": "设置机器人扩展板 RGB 灯的颜色(不动车)。color 可取 red/green/blue/yellow/cyan/magenta/white/orange/off 或 #RRGGBB。用于状态/情绪可视化反馈。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "color": {"type": "string", "description": "颜色名或 #RRGGBB,默认 green"},
                "index": {"type": "string", "enum": ["both", "left", "right"], "description": "左/右/两盏,默认 both"},
            },
            "required": ["color"],
        },
    },
    {
        "name": "robot.color_detect",
        "description": "用摄像头识别画面中出现的颜色(红/绿/蓝/黄/白/黑等,不动车),返回各颜色的占比面积与位置。用于'看看这是什么颜色''画面里有红色吗'等场景。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "timeout_sec": {"type": "number", "description": "采样时长,秒,0.5~5,默认 2"},
            },
            "required": [],
        },
    },
    {
        "name": "robot.camera_snapshot",
        "description": "用云台摄像头拍一张快照并保存到机器人本地(不动车),返回图片文件路径。用于留档/排查画面。",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "robot.arm_ik",
        "description": "用逆运动学把机械臂末端移动到指定坐标 x/y/z(单位厘米,不动车轮)。安全边界会自动限幅。用于'把手伸到左边 5cm 高 12cm'这类精确定位。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "number", "description": "左右偏移,厘米,-12~12"},
                "y": {"type": "number", "description": "前后深度,厘米,0~16"},
                "z": {"type": "number", "description": "高度,厘米,4~30"},
                "pitch": {"type": "number", "description": "末端俯仰角,-90~90,默认 0"},
            },
            "required": ["x", "y", "z"],
        },
    },
    {
        "name": "robot.press",
        "description": "用机械臂做一次'点按':先悬停到接触点上方 hover_cm,再下压到接触点 (x,y,z),停顿后抬起回悬停位。坐标是机械臂基座系(单位厘米),由调用方手动给出(不含视觉解算),用于探测真实定位精度(例如'把手按到前方 10cm 高 5cm 处')。安全盒自动限幅,任一段无解即中止。绝不动车轮。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "number", "description": "左右偏移,厘米,-12~12"},
                "y": {"type": "number", "description": "前后深度,厘米,0~16"},
                "z": {"type": "number", "description": "接触点高度,厘米,4~30"},
                "pitch": {"type": "number", "description": "末端俯仰角,-90~90,默认 0"},
                "hover_cm": {"type": "number", "description": "下压前悬停高度增量,厘米,0.5~10,默认 3"},
                "hold_ms": {"type": "number", "description": "按住时长毫秒,0~2000,默认 250"},
            },
            "required": ["x", "y", "z"],
        },
    },
    {
        "name": "robot.grasp",
        "description": "用机械臂夹爪抓取一个物体(宏,带视觉自判):抬臂→张开→回校验机位拍前帧→移到物体上方→下探→合爪→抬起→回同一机位拍后帧。本机全身开环 PWM 舵机、无夹持/力反馈,故用相机比较'桌上物体区域'前后帧来自判夹没夹到:物体被抬离桌面(该区域亮白消失)则 grasped=true,还在原位则 grasped=false。坐标 (x,y,z) 为物体处夹爪应到达的抓取点(机械臂基座系,单位厘米,桌面物体需负 z),由调用方手动给出(不含视觉解算)。建议 pitch=-90 使夹爪竖直朝下。verify=false 可关自判。安全盒自动限幅。绝不动车轮。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "number", "description": "左右偏移,厘米,-18~18"},
                "y": {"type": "number", "description": "前后深度,厘米,0~17"},
                "z": {"type": "number", "description": "抓取高度,厘米,-3~30(原点=臂底座,桌面在负区;已验证白色物体示教位 z=-1)"},
                "pitch": {"type": "number", "description": "末端俯仰角,-90~90;抓取建议 -90(夹爪竖直朝下),默认 0"},
                "hover_cm": {"type": "number", "description": "下探前悬停高度增量,厘米,1~12,默认 4"},
                "lift_cm": {"type": "number", "description": "抓起后抬起高度增量,厘米,2~18,默认 6"},
                "verify": {"type": "boolean", "description": "是否启用视觉自判(默认 true):回校验机位拍前后帧比桌上物体区域亮白,自动判 grasped 真假;非白色/不可见物体可置 false"},
            },
            "required": ["x", "y", "z"],
        },
    },
    {
        "name": "robot.gripper",
        "description": "独立控制机械臂夹爪的开合(伺服舵机 servo1),不带动机械臂关节也不动车轮。用于示教/调试:先把夹爪张开,手动将物体送到两爪之间,再合爪。action=open(全开)/close(夹紧)/half(半开)为预设,优先于 pulse;pulse 为裸脉宽 1000(夹紧)~2000(全开)。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["open", "close", "half"], "description": "预设动作,优先于 pulse"},
                "pulse": {"type": "number", "description": "裸脉宽 1000~2000,action 未给时生效,默认 1800"},
                "travel_sec": {"type": "number", "description": "行程时间(秒),0.1~2,默认 0.5"},
            },
        },
    },
]


def build_dispatcher(robot):
    """把工具名映射到 Robot 方法,返回 (name -> callable(args)->result)。"""
    def _drive(a):
        return robot.drive(a.get("direction", "stop"), a.get("duration_sec", 1.0), a.get("speed", 0.3))

    # 真机模式后台预热 cv2/vision(派上 SD 卡冷 import 可达数十秒),
    # 避免首次 search_face 调用时现 import 超时。
    if not robot.dry_run:
        def _prewarm():
            try:
                import vision  # noqa: F401  (内部懒加载 cv2/numpy)
                import cv2  # noqa: F401
                log.info("cv2 prewarm done")
            except Exception as e:  # 预热失败不阻断启动,首次调用会如实报错
                log.warning("cv2 prewarm failed: %r", e)
        threading.Thread(target=_prewarm, daemon=True).start()

    return {
        "robot.drive": _drive,
        "robot.arm_pose": lambda a: robot.arm_pose(a.get("pose", "reset")),
        "robot.pick": lambda a: robot.pick(a.get("target", "")),
        "robot.place": lambda a: robot.place(a.get("target", "")),
        "robot.take_photo": lambda a: robot.take_photo(),
        "robot.search_face": lambda a: robot.search_face(a.get("max_scan_sec", 20)),
        "robot.face_enroll": lambda a: robot.face_enroll(a.get("name", ""),
                                                          a.get("frames", 5),
                                                          id=a.get("id")),
        "robot.face_recognize": lambda a: robot.face_recognize(),
        "robot.face_list": lambda a: robot.face_list(),
        "robot.face_delete": lambda a: robot.face_delete(a.get("name", "")),
        "robot.face_rename": lambda a: robot.face_rename(a.get("key", ""),
                                                          a.get("id"), a.get("name")),
        "robot.face_login": lambda a: robot.face_login(),
        "robot.face_logout": lambda a: robot.face_logout(),
        "robot.face_align": lambda a: robot.face_align(a.get("action", "center"),
                                                        a.get("step", 100)),
        "robot.play_music": lambda a: robot.play_music(a.get("keyword", "")),
        "robot.stop_music": lambda a: robot.stop_music(),
        "robot.beep": lambda a: robot.beep(),
        "robot.get_battery": lambda a: robot.get_battery(),
        "robot.get_distance": lambda a: robot.get_distance(),
        "robot.set_rgb": lambda a: robot.set_rgb(a.get("color", "green"),
                                                  a.get("index", "both"),
                                                  bool(a.get("breath", False)),
                                                  a.get("cycle_ms", 2000)),
        "robot.color_detect": lambda a: robot.color_detect(a.get("timeout_sec", 2)),
        "robot.camera_snapshot": lambda a: robot.camera_snapshot(),
        "robot.arm_ik": lambda a: robot.arm_ik(a.get("x", 0), a.get("y", 6), a.get("z", 18),
                                                a.get("pitch", 0), a.get("movetime_ms", 1500)),
        "robot.press": lambda a: robot.press(a.get("x", 0), a.get("y", 6), a.get("z", 6),
                                             a.get("pitch", 0), a.get("hover_cm", 3),
                                             a.get("hold_ms", 250), a.get("movetime_ms", 1200)),
        "robot.grasp": lambda a: robot.grasp(a.get("x", 0), a.get("y", 12), a.get("z", 4),
                                             a.get("pitch", 0), a.get("hover_cm", 4),
                                             a.get("lift_cm", 6), a.get("grip_travel", 0.5),
                                             a.get("movetime_ms", 1200), a.get("home", True),
                                             a.get("verify", True)),
        "robot.gripper": lambda a: robot.gripper(a.get("pulse", 1800), a.get("action"),
                                                 a.get("travel_sec", 0.5)),
    }
