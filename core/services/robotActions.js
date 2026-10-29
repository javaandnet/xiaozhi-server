// Robot action-type catalog — single source of truth shared by the docs and the
// per-device settings page. Mirrors the MasterPi device-side tools
// (masterpi/tools.py + masterpi/robot.py). Tool ids are the SANITIZED MCP names
// (robot.arm_pose -> robot_arm_pose) exactly as they appear in function.name when
// injected into the LLM, so the settings selection can filter one-to-one.
//
// Fields:
//   id        sanitized tool name (used for robot.actions selection + filtering)
//   macro     original device macro name
//   label     display name (zh)
//   category  grouping for the UI: body | vision | audio | chassis
//   physical  whether it moves real hardware by default
//   wired     whether the device backend is wired to hardware (vs _pending)
//   args      semantic arguments exposed to the LLM
//   note      safety / behavior remark

const ACTION_TYPES = [
  {
    id: 'robot_arm_pose',
    macro: 'robot.arm_pose',
    label: '机械臂语义动作',
    category: 'body',
    physical: true,
    wired: true,
    args: 'pose：greet/thanks(打招呼/致谢) · wave(挥手) · nod(点头) · shake(摇头) · reach_left/reach_right(向前左右伸) · bow(鞠躬) · raise_right(举手) · dance(短舞) · reset(归位)',
    note: '仅舵机、绝不触碰底盘；预置安全动作宏（厂商动作组+程序化生成），LLM 只给语义名不给关节角度。',
  },
  {
    id: 'robot_beep',
    macro: 'robot.beep',
    label: '提示音',
    category: 'audio',
    physical: true,
    wired: true,
    args: '（无参数）',
    note: '链路验证用，一声 beep。',
  },
  {
    id: 'robot_play_music',
    macro: 'robot.play_music',
    label: '播放音乐',
    category: 'audio',
    physical: false,
    wired: false,
    args: 'keyword：歌名/歌手等搜索词，如 "晴天 周杰伦"',
    note: '真机尚未接线（_pending），调用如实返回未实现，不假装成功。',
  },
  {
    id: 'robot_stop_music',
    macro: 'robot.stop_music',
    label: '停止音乐',
    category: 'audio',
    physical: false,
    wired: false,
    args: '（无参数）',
    note: '停掉当前播放；随播放器一同尚未接线。',
  },
  {
    id: 'robot_pick',
    macro: 'robot.pick',
    label: '抓取物体',
    category: 'body',
    physical: false,
    wired: false,
    args: 'target：物体语义描述，如 "红色方块" "桌上的苹果"',
    note: '坐标由本地视觉解算，LLM 只给语义目标；尚未接线。',
  },
  {
    id: 'robot_place',
    macro: 'robot.place',
    label: '放置物体',
    category: 'body',
    physical: false,
    wired: false,
    args: 'target：放置位置语义描述，如 "盒子里" "桌子上"',
    note: '尚未接线。',
  },
  {
    id: 'robot_take_photo',
    macro: 'robot.take_photo',
    label: '拍照识别',
    category: 'vision',
    physical: false,
    wired: false,
    args: '（无参数）',
    note: '云台拍照用于"看看这是什么"类问答；属感知查询，动作后仍需 LLM 看图作答（不做极短确认）。',
  },
  {
    id: 'robot_search_face',
    macro: 'robot.search_face',
    label: '人脸搜寻巡视',
    category: 'vision',
    physical: true,
    wired: true,
    args: 'max_scan_sec：扫描时间上限秒数（5~25，默认20）',
    note: '舵机扫描（s1躯干/s3颈/s6头）+ DNN(YuNet) 人脸检测；命中 即**开环扫描对准人脸**（每轮先扫头 s6 做水平、再扫颈 s3 做垂直——pan 会耦合影响竖直故垂直收尾，取画面最居中档，多帧中位数，把脸拉到 正中）+蜂鸣+停止；对准后 SFace 识人（比对派上人脸库，返回 person，陌生/未登记为 null）；命中后端侧上报 face_found 事件（含 person），由 server 统一调度播报（反查 settings.robot.body 绑定的在线小智语音设备，按该设备语言播报固定 文案 faceFound/faceFoundNamed）；vision 类不做极短确认；绝不碰轮子。预览流在线时自动借检测框与预览共存。',
  },
  {
    id: 'robot_face_enroll',
    macro: 'robot.face_enroll',
    label: '人脸登记',
    category: 'vision',
    physical: true,
    wired: true,
    args: 'name：人的称呼/姓名（库内不可重复） · id：可选稳定编号（不填自动生成 p_xxxxxx，重复拒绝） · frames：采集帧数（3~8，默认5）',
    note: '引导式登记：当前画面无足够大的正脸时先复用扫描+对准把脸摆正，再多帧采 SFace 嵌入写入派上 faces.json（按 ID 存储，每人最多 5 样本）；需被登记者在镜头里、正面、保持不动；预览开着也可登记（自动借帧）；绝不碰轮子。',
  },
  {
    id: 'robot_face_recognize',
    macro: 'robot.face_recognize',
    label: '人脸识别',
    category: 'vision',
    physical: false,
    wired: true,
    args: '（无参数）',
    note: '只识人不扫描：当前画面取几帧 SFace 嵌入比对人脸库，多数表决返回 person（陌生/未匹配为 null）；不动车。',
  },
  {
    id: 'robot_face_list',
    macro: 'robot.face_list',
    label: '人脸库列表',
    category: 'vision',
    physical: false,
    wired: true,
    args: '（无参数）',
    note: '列已登记成员（ID/称呼/样本数/登记时间）、当前阈值与当前登录人；纯 JSON 读取，不动相机不运动。',
  },
  {
    id: 'robot_face_rename',
    macro: 'robot.face_rename',
    label: '人脸库编辑',
    category: 'vision',
    physical: false,
    wired: true,
    args: 'key：现有成员的 ID 或称呼 · id：新 ID（可选） · name：新称呼（可选）',
    note: '修改已登记成员的 ID/称呼（两者均可改）；新值全局查重（大小写不敏感），重复则拒绝；登录态随 ID 迁移；纯 JSON 写入，不运动。',
  },
  {
    id: 'robot_face_login',
    macro: 'robot.face_login',
    label: '人脸登录',
    category: 'vision',
    physical: false,
    wired: true,
    args: '（无参数）',
    note: '人脸识别登录：看当前画面识人（不扫描不转身），认出已登记成员则记为 faces.json 的“当前登录人”（face_list 可查）；**默认关闭**（需先在人脸库设置打开开关 robot.vision.faceLoginEnabled，未开启时调用优雅返回“未开启”）；陌生/未登记脸登录失败；不动车。',
  },
  {
    id: 'robot_face_logout',
    macro: 'robot.face_logout',
    label: '退出登录',
    category: 'vision',
    physical: false,
    wired: true,
    args: '（无参数）',
    note: '清除人脸库的当前登录人；纯 JSON 写入，不运动。',
  },
  {
    id: 'robot_face_delete',
    macro: 'robot.face_delete',
    label: '人脸库删除',
    category: 'vision',
    physical: false,
    wired: true,
    args: 'name：要删除的 ID 或称呼',
    note: '从人脸库删除指定成员（按 ID 或称呼定位）；若其正是当前登录人则同步登出；纯 JSON 写入，不运动。',
  },
  {
    id: 'robot_get_battery',
    macro: 'robot.get_battery',
    label: '电池电压读取',
    category: 'sensor',
    physical: false,
    wired: true,
    args: '（无参数）',
    note: 'board.get_battery 读原始电压（mV 假设），用于低电提醒/状态上报；不运动。',
  },
  {
    id: 'robot_get_distance',
    macro: 'robot.get_distance',
    label: '超声波测距',
    category: 'sensor',
    physical: false,
    wired: true,
    args: '（无参数）',
    note: 'I2C 超声波模块（Sonar.getDistance，地址 0x77）测前方障碍物距离，返回 cm；不动车；本机未接该模块时会优雅返回 clear=false。',
  },
  {
    id: 'robot_set_rgb',
    macro: 'robot.set_rgb',
    label: 'RGB 状态灯',
    category: 'light',
    physical: false,
    wired: true,
    args: 'color：预设名(red/green/blue/...) 或 #RRGGBB · index：both/left/right',
    note: '扩展板两盏 RGB 灯（走厂商串口 board.set_rgb，非 I2C），用于状态/情绪可视化反馈；不动车。',
  },
  {
    id: 'robot_color_detect',
    macro: 'robot.color_detect',
    label: '颜色识别',
    category: 'vision',
    physical: false,
    wired: true,
    args: 'timeout_sec：采样时长秒（0.5~5，默认2）',
    note: '纯相机：按厂商 LAB 阈值表（lab_config.yaml）识别画面中出现的颜色与面积；不动车。',
  },
  {
    id: 'robot_camera_snapshot',
    macro: 'robot.camera_snapshot',
    label: '相机抓拍',
    category: 'vision',
    physical: false,
    wired: true,
    args: '（无参数）',
    note: '抓一帧存为本地 JPEG并返回路径；不动车；用于留档/排查画面。',
  },
  {
    id: 'robot_arm_ik',
    macro: 'robot.arm_ik',
    label: '机械臂坐标摆放',
    category: 'body',
    physical: true,
    wired: true,
    args: 'x/y/z：末端目标坐标（厘米，安全盒 x-12~12/y0~16/z4~30）· pitch：俯仰角',
    note: '逆运动学摆放机械臂（复用共享 board，不二次占用串口）；坐标自动限幅到安全盒，无解则 found=false；绝不动车轮。',
  },
  {
    id: 'robot_press',
    macro: 'robot.press',
    label: '机械臂点按（精度探测）',
    category: 'body',
    physical: true,
    wired: true,
    args: 'x/y/z：接触点坐标（厘米，安全盒 x-12~12/y0~16/z4~30）· pitch · hover_cm：下压前悬停增量（0.5~10，默认3）· hold_ms：按住时长（0~2000，默认250）',
    note: '三段 IK 演示“点按”：悬停→下压→抬起。坐标由调用方手动给出（机体系，不含视觉解算），用于探测真实定位精度；各段自动限幅，任一段无解即中止并如实返回失败段+实际坐标；绝不动车轮。手喂坐标的诊断工具，默认不勾选进语音动作目录（需 robot.actions 显式启用才会注入 LLM）。',
  },
  {
    id: 'robot_grasp',
    macro: 'robot.grasp',
    label: '机械臂抓取（精度练习）',
    category: 'body',
    physical: true,
    wired: true,
    args: 'x/y/z：物体处夹爪抓取点坐标（厘米，抓取盒 x-18~18/y0~17/z-3~30）· pitch · hover_cm：下探前悬停增量（1~12，默认4）· lift_cm：抓起后抬起增量（2~18，默认6）· verify：是否启用视觉自判（默认 true）',
    note: '夹爪抓取宏（servo1 开2000/合1500，厂商 color_sorting 实测参数）：抬臂→张开→(回校验机位拍前帧)→移到物体上方→下探→合爪→抬起→(回同一机位拍后帧)。本机全身开环 PWM 舵机、无夹持/力反馈，故 verify=true 用相机自判夹没夹到：比较校验机位下“桌上物体区”前后帧，物体被抬离桌面则 grasped=true，否则 false（已真机标定：需白色物体、落在画面中央搜索窗内、机位停稳 2.8s 防开环漂移；取帧失败/物体不可见则弃权 grasped=null）。z 原点=臂底座，桌面物体在负 z 区。注：能可靠“判夹没夹到”，但把夹爪对准物体仍需手眼标定（无标定下靠网格搜索）；**绝不动车轮**。手喂坐标的诊断工具，默认不入语音动作目录。',
  },
  {
    id: 'robot_gripper',
    macro: 'robot.gripper',
    label: '夹爪独立开合（示教）',
    category: 'body',
    physical: true,
    wired: true,
    args: 'action：open/close/half（预设，优先于 pulse）· pulse：裸脉宽 1000~2000（默认1800）· travel_sec：行程秒（0.1~2，默认0.5）',
    note: '只控 servo1 夹爪，不带动机械臂关节也不动车轮。示教用：先张爪、人工把物体送到两爪之间、再合爪。注：pwm_servo_read_position 只回显 PCA9685 输出寄存器（=命令值）而非真实轴位，故不提供回读判据。手喂参数的诊断工具，默认不入语音动作目录。',
  },
  {
    id: 'robot_drive',
    macro: 'robot.drive',
    label: '底盘移动',
    category: 'chassis',
    physical: false,
    wired: true,
    args: 'direction：forward/backward/left/right/turn_left/turn_right/stop · duration_sec(0~5) · speed(0~0.5)',
    note: '安全红线：默认 robot.allowChassis=false，真机会拒绝（机器常放桌上，一动有坠落风险）；每次移动后自动收油。',
  },
];

const CATEGORY_LABEL = {
  body: '身体动作',
  vision: '感知/问答',
  sensor: '传感器',
  light: '灯光',
  audio: '声音',
  chassis: '底盘（需放开红线）',
};

/** All valid action ids (for validation). */
export function actionIds() {
  return ACTION_TYPES.map((a) => a.id);
}

/** The full catalog with category labels attached. */
export function getActionCatalog() {
  return ACTION_TYPES.map((a) => ({ ...a, categoryLabel: CATEGORY_LABEL[a.category] || a.category }));
}

export default ACTION_TYPES;
