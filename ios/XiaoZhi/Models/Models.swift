import Foundation

// MARK: - 服务健康（GET /health）

/// xiaozhi-server 运行时状态；字段全可选，后端版本升级不致解析失败。
struct XZHealth: Decodable {
    let status: String?
    let channel: String?
    let devices: Int?
    let uptime: Double?

    var isOK: Bool { status == "ok" }
}

// MARK: - 实时在线设备（GET /api/devices，device.toJSON() 口径，camelCase）

struct XZLiveDevice: Decodable, Identifiable, Hashable {
    let deviceId: String?
    let clientId: String?
    let name: String?
    let type: String?
    let status: String?
    let ip: String?
    let mac: String?
    let version: String?
    let battery: Int?
    let signal: Int?
    let lastActivity: String?

    var id: String { deviceId ?? clientId ?? UUID().uuidString }
    var isOnline: Bool { status == "online" }
    var displayName: String {
        if let n = name, !n.isEmpty { return n }
        return deviceId ?? "未知设备"
    }
}

// MARK: - 已登记设备（GET /api/devices/known，DB 行口径，snake_case）

struct XZKnownDevice: Decodable, Identifiable, Hashable {
    let device_id: String?
    let name: String?
    let type: String?
    let model: String?
    let mac: String?
    let ip: String?
    let online: Int?
    let rest: Int?
    let robot: Int?
    let robotBody: String?
    let home: Int?
    let last_seen: Int?
    let device_ids: [String]?

    enum CodingKeys: String, CodingKey {
        case device_id, name, type, model, mac, ip, online, rest, robot, home, last_seen, device_ids
        case robotBody = "robot_body"
    }

    var id: String { device_id ?? UUID().uuidString }
    var isOnline: Bool { (online ?? 0) == 1 }
    var isResting: Bool { (rest ?? 0) == 1 }
    var isRobot: Bool { (robot ?? 0) == 1 }
    var isHome: Bool { (home ?? 0) == 1 }
    var displayName: String {
        if let n = name, !n.isEmpty { return n }
        if let m = model, !m.isEmpty { return m }
        return device_id ?? "未知设备"
    }
    /// 供控制/查询用的规范 deviceId（优先主键，回落 mac）
    var keyId: String { device_id ?? mac ?? "" }
}

// MARK: - per-device 设定（GET/POST /api/settings/device）

/// 机器人硬件设定：enabled=是否注入身体人设/工具；body=绑定的身体 providerKey；actions=动作白名单
struct XZRobotSettings: Codable {
    var enabled: Bool?
    var body: String?
    var maxFunctions: Int?
    var actions: [String]?
}

/// 智能家居设定：enabled=true 的会话才注入 HomeKit 灯具工具
struct XZHomeDeviceSettings: Codable {
    var enabled: Bool?
}

struct XZDeviceSettings: Codable {
    var language: String?
    var robot: XZRobotSettings?
    var home: XZHomeDeviceSettings?
}

/// GET /api/settings/device 回执
struct XZDeviceSettingsEnvelope: Decodable {
    let ok: Bool?
    let deviceId: String?
    let settings: XZDeviceSettings?
    let error: String?
}

/// POST /api/settings/device 回执
struct XZDeviceSettingsAck: Decodable {
    let ok: Bool?
    let deviceId: String?
    let settings: XZDeviceSettings?
    let error: String?
}

struct XZDevicePage: Decodable {
    let total: Int?
    let items: [XZKnownDevice]?
}

// MARK: - 对话记录（GET /api/conversations，DB 行口径，snake_case）

struct XZConversation: Decodable, Identifiable {
    let id: Int?
    let session_id: String?
    let device_id: String?
    let client_id: String?
    let role: String?
    let text: String?
    let emotion: String?
    let created_at: Int?

    var isUser: Bool { role == "user" }
    var date: Date? {
        created_at.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) }
    }
}

struct XZConversationPage: Decodable {
    let total: Int?
    let items: [XZConversation]?
}

// MARK: - 操作回执

/// POST /api/broadcast 受理回执
struct XZBroadcastAck: Decodable {
    let success: Bool?
    let accepted: Bool?
    let devices: Int?
    let message: String?
    let error: String?
}

/// POST /api/wake 受理回执
struct XZWakeAck: Decodable {
    let success: Bool?
    let devices: Int?
    let message: String?
    let error: String?
}

/// POST /api/voice/speak 受理回执（需 X-Xiaozhi-Key）
struct XZVoiceSpeakAck: Decodable {
    let ok: Bool?
    let accepted: Bool?
    let devices: Int?
    let error: String?
}

/// POST /api/voice/devices 在线设备（需 X-Xiaozhi-Key）
struct XZVoiceDevice: Decodable, Identifiable {
    let deviceId: String?
    let clientId: String?
    let name: String?
    var id: String { deviceId ?? UUID().uuidString }
}

struct XZVoiceDeviceList: Decodable {
    let ok: Bool?
    let devices: [XZVoiceDevice]?
}

// MARK: - 机器人（MasterPi / device-MCP 身体）

/// GET /api/mcp/status 的身体提供方（camelCase）
struct XZMcpProvider: Decodable, Identifiable, Hashable {
    let clientId: String?
    let deviceId: String?
    let mac: String?
    let name: String?
    let version: String?
    let ready: Bool?
    let toolCount: Int?
    let deviceType: String?
    let robot: Bool?

    var id: String { deviceId ?? clientId ?? UUID().uuidString }
    var isRobot: Bool { robot == true }
    var isReady: Bool { ready == true }
    var displayName: String { name?.isEmpty == false ? name! : (deviceId ?? "未知身体") }
    /// 控制/查询用的 device key（getFunctionDescriptionsForProvider 按 mac/deviceId/clientId 归一，优先 deviceId）
    var key: String { deviceId ?? mac ?? clientId ?? "" }
}

struct XZMcpStatus: Decodable {
    let ok: Bool?
    let providers: [XZMcpProvider]?
    let readyProviders: Int?
    let totalTools: Int?
    let robotReadyProviders: Int?
    let robotTotalTools: Int?
}

/// GET /api/mcp/tools?device= 的单工具描述
struct XZMcpTool: Decodable, Identifiable {
    let name: String?
    let description: String?
    let parameters: JSONValue?
    var id: String { name ?? UUID().uuidString }
    var displayName: String { name ?? "-" }
}

struct XZMcpToolList: Decodable {
    let ok: Bool?
    let device: String?
    let tools: [XZMcpTool]?
    let error: String?
}

/// POST /api/mcp/call 回执（result 为字符串化结果）
struct XZMcpCallAck: Decodable {
    let ok: Bool?
    let device: String?
    let tool: String?
    let result: String?
    let error: String?
}

/// GET /api/robot/action-types 动作目录项
struct XZRobotAction: Decodable, Identifiable {
    let id: String?
    let macro: String?
    let label: String?
    let category: String?
    let categoryLabel: String?
    let physical: Bool?
    let wired: Bool?
    let args: String?
    let note: String?
}

struct XZRobotActionCatalog: Decodable {
    let ok: Bool?
    let items: [XZRobotAction]?
}

/// POST /api/device/command 回执（自然语言 → LLM → 定向执行）
struct XZDeviceCommandAck: Decodable {
    let ok: Bool?
    let device: String?
    let text: String?
    let reply: String?
    let toolCount: Int?
    let spoken: String?
    let routed: String?
    let error: String?
}

// MARK: - MasterPi 人脸登记

/// GET/POST /api/masterpi/stream/*：预览流状态（url 为树莓派 MJPEG 基址，图为 url+"stream"）
struct XZStreamStatus: Decodable {
    let ok: Bool?
    let running: Bool?
    let port: Int?
    let url: String?
    let error: String?

    /// 拼出供 WKWebView 直读的 MJPEG 地址（带时间戳防缓存）
    var streamURL: String? {
        guard let base = url, !base.isEmpty else { return nil }
        let normalized = base.hasSuffix("/") ? base : base + "/"
        return normalized + "stream?_=" + String(Int(Date().timeIntervalSince1970 * 1000))
    }
}

/// 人脸库成员（face_db list）
struct XZFacePerson: Decodable, Identifiable, Hashable {
    let id: String?
    let name: String?
    let samples: Int?
    var displayName: String { name?.isEmpty == false ? name! : (id ?? "未命名") }
}

/// GET /api/masterpi/faces 回执（snake_case）
struct XZFaceList: Decodable {
    let ok: Bool?
    let persons: [XZFacePerson]?
    let currentLogin: String?
    let faceLoginEnabled: Bool?
    let threshold: Double?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case ok, persons, threshold, error
        case currentLogin = "current_login"
        case faceLoginEnabled = "face_login_enabled"
    }
}

/// robot_face_enroll（guided）返回体，经 /api/mcp/call 的 result 字符串解析
struct XZFaceEnrollResult: Decodable {
    let enrolled: Bool?
    let id: String?
    let name: String?
    let samples: Int?
    let error: String?
    let reason: String?
}

/// robot_face_align 返回体
struct XZFaceAlignResult: Decodable {
    let ok: Bool?
    let s3: Int?
    let s6: Int?
    let error: String?
}

/// robot_face_login 返回体
struct XZFaceLoginResult: Decodable {
    let logged_in: Bool?
    let id: String?
    let name: String?
}

// MARK: - 家庭设备（HomeKit）

/// GET /api/homekit/status 的可控灯具
struct XZHomeLight: Decodable, Identifiable, Hashable {
    let key: String?
    let name: String?
    let hasBrightness: Bool?
    let hasColorTemp: Bool?
    var id: String { key ?? UUID().uuidString }
    var displayName: String { name?.isEmpty == false ? name! : (key ?? "灯") }
}

struct XZHomeStatus: Decodable {
    let ok: Bool?
    let enabled: Bool?
    let deviceName: String?
    let discoveryTimeoutMs: Int?
    let paired: [String]?
    let lights: [XZHomeLight]?
    let error: String?
}

/// POST /api/homekit/scan 发现的局域网配件
struct XZHomeScanDevice: Decodable, Identifiable {
    let accessoryId: String?   // JSON 里的 id（HomeKit 配件标识）
    let name: String?
    let address: String?
    let port: Int?
    let availableForPairing: Bool?
    let pairedHere: Bool?

    enum CodingKeys: String, CodingKey {
        case accessoryId = "id", name, address, port, availableForPairing, pairedHere
    }
    var id: String { (accessoryId ?? name ?? UUID().uuidString) + "\(address ?? "")" }
}

struct XZHomeScanResult: Decodable {
    let ok: Bool?
    let devices: [XZHomeScanDevice]?
    let error: String?
}

/// 家庭设备设定（GET/POST /api/homekit/settings）
struct XZHomeSettings: Codable {
    var enabled: Bool?
    var deviceName: String?
    var discoveryTimeoutMs: Int?
}

struct XZHomeSettingsEnvelope: Decodable {
    let ok: Bool?
    let settings: XZHomeSettings?
    let error: String?
}

/// POST /api/homekit/control 回执（result 为中文据实文案）
struct XZHomeControlAck: Decodable {
    let ok: Bool?
    let result: String?
    let error: String?
}

/// POST /api/homekit/rename 回执（persisted=已写入 config.json → homekit.names）
struct XZHomeRenameAck: Decodable {
    let ok: Bool?
    let light: String?
    let name: String?
    let persisted: Bool?
    let error: String?
}

// MARK: - 通用 JSON（承接工具 parameters 等不定结构）

enum JSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        self = .null
    }
}
