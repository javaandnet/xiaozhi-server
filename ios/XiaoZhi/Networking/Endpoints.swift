import Foundation

/// xiaozhi-server 端点清单（与 index.js setupRoutes 逐条对齐）。
/// 路径均相对服务根地址，API 前缀 /api 在此统一拼入。
enum Endpoint {
    static let health = "health"                 // GET  免鉴权
    static let devices = "api/devices"           // GET  实时在线设备
    static let knownDevices = "api/devices/known" // GET  已登记设备（含离线）
    static let settingsDevice = "api/settings/device" // GET/POST per-device 设定（机器人/家居/语言）
    static let conversations = "api/conversations" // GET  对话记录
    static let broadcast = "api/broadcast"       // POST 文本播报（免鉴权）
    static let wake = "api/wake"                 // POST 远程唤醒（免鉴权）
    static let voiceSpeak = "api/voice/speak"    // POST 文本播报（需 X-Xiaozhi-Key）
    static let voiceDevices = "api/voice/devices" // POST 在线设备（需 X-Xiaozhi-Key）

    // 机器人（MasterPi / device-MCP 身体），均免鉴权
    static let mcpStatus = "api/mcp/status"              // GET  身体在线/工具数概览
    static let mcpTools = "api/mcp/tools"               // GET  ?device= 列该身体工具
    static let mcpCall = "api/mcp/call"                 // POST 直调某身体工具
    static let robotActionTypes = "api/robot/action-types" // GET  动作类型目录
    static let deviceCommand = "api/device/command"     // POST 自然语言 → LLM → 定向执行
    static let masterpiSpeak = "api/masterpi/speak"     // POST 发送语音（文字播报到绑定的小智设备，Web 同口径）
    static let masterpiIkJog = "api/masterpi/ik/jog"    // POST IK 微调（基准由 server 统一维护，双端共用）
    static let masterpiReconnect = "api/masterpi/reconnect" // POST 重连身体（server 经 SSH 重启派侧 client，僵尸连接自愈）

    // MasterPi 人脸登记（免鉴权 LAN 控制口；云端 hub 侧经 peer 转发家里执行）
    static let faceStreamStatus = "api/masterpi/stream/status" // GET  预览流状态/URL/mode
    static let faceStreamStart = "api/masterpi/stream/start"   // POST 启动 MJPEG 预览（body 可带 mode）
    static let faceStreamStop = "api/masterpi/stream/stop"     // POST 停止并释放相机
    static let faceStreamMode = "api/masterpi/stream/mode"     // POST 运行中切档 face/preview/watch
    static let watchEvents = "api/masterpi/stream/watch/events" // GET  看家事件列表
    static let watchShot = "api/masterpi/stream/watch/shot"     // GET  ?name= 快照 JPEG（云端 hub 经 peer 转发同样可用）
    static let masterpiShutdown = "api/masterpi/shutdown"       // POST 机器人软关机（shutdown -h）
    static let masterpiSafety = "api/masterpi/safety"           // GET/POST 底盘安全开关
    static let facesList = "api/masterpi/faces"                // GET  人脸库列表

    // 外出（hub 实例）画面回源：经互联帧中继，需 X-Peer-Key 头
    static let peerCameraFeed = "api/peer/camera/feed"         // GET  multipart MJPEG 中继
    static let peerCameraShot = "api/peer/camera/shot"         // GET  ?name= 快照 JPEG 中继

    // 家庭设备（HomeKit 方案A），均免鉴权
    static let homekitStatus = "api/homekit/status"     // GET  已配对灯具/状态
    static let homekitSettings = "api/homekit/settings" // GET/POST 家庭设备设定
    static let homekitControl = "api/homekit/control"   // POST 灯具开关/亮度/色温
    static let homekitScan = "api/homekit/scan"         // POST 扫描局域网配件
    static let homekitPair = "api/homekit/pair"         // POST 配对（pin + deviceName）
    static let homekitRename = "api/homekit/rename"     // POST 灯具重命名（持久化 config.json）

    /// /api/voice/* 端点需带共享密钥头，其它端点免鉴权
    static func requiresVoiceKey(_ path: String) -> Bool {
        path.hasPrefix("api/voice/")
    }
}
