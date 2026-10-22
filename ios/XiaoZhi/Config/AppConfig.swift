import Foundation

/// 全局运行配置。后端地址优先级：**用户选的接入环境 > 用户自设地址 > Info.plist / 编译默认**。
/// - 局域网（内置）：Info.plist 的 `XiaoZhiBaseURL`（真机连 Mac 开发服务，默认端口 8003）；
/// - 公网服务器：`XiaoZhiCloudBaseURL`（nginx 反代到 xiaozhi-server，挂在 /xiaozhi 前缀下）；
/// - 自定义：设置页手填地址（换 Mac IP、临时指向别的机器）。
/// xiaozhi-server 端点在根路径（health、/api/*），故自定义地址只补 scheme、不追加 /api。
enum AppConfig {
    /// 接入环境档
    enum ServerEnv: String, CaseIterable, Identifiable {
        case builtin   // 局域网 / 内置
        case cloud     // 公网服务器
        case custom    // 手填
        var id: String { rawValue }
        var title: String {
            switch self {
            case .builtin: return "局域网"
            case .cloud:   return "公网服务器"
            case .custom:  return "自定义"
            }
        }
        var icon: String {
            switch self {
            case .builtin: return "house"
            case .cloud:   return "cloud"
            case .custom:  return "slider.horizontal.3"
            }
        }
    }

    /// 用户自设服务器地址的 UserDefaults 键 + 当前档位键
    private static let serverOverrideKey = "appServerBaseURL"
    private static let envKey = "appServerEnv"

    /// 公网服务器根地址（Info.plist 注入，缺省回落到内置常量；nginx 前缀 /xiaozhi）
    static let cloudBaseURL: URL = {
        if let s = Bundle.main.object(forInfoDictionaryKey: "XiaoZhiCloudBaseURL") as? String,
           let url = URL(string: s), !s.contains("your-server.example.com") {
            return url
        }
        return URL(string: "https://ai.fsr.co.jp/xiaozhi")!
    }()

    /// 局域网默认地址：Info.plist → DEBUG 环境变量 → 回环（xiaozhi-server 默认端口 8003）
    static let defaultBaseURL: URL = {
        if let s = Bundle.main.object(forInfoDictionaryKey: "XiaoZhiBaseURL") as? String,
           let url = URL(string: s), !s.contains("your-server.example.com") {
            return url
        }
        #if DEBUG
        if let env = ProcessInfo.processInfo.environment["XIAOZHI_BASE_URL"],
           let url = URL(string: env) {
            return url
        }
        #endif
        return URL(string: "http://127.0.0.1:8003")!
    }()

    /// 当前生效档。旧版只存过自设地址、没有档概念 —— 那种情况按 custom 处理，避免升级后地址失效
    static var env: ServerEnv {
        get {
            if let raw = UserDefaults.standard.string(forKey: envKey), let e = ServerEnv(rawValue: raw) { return e }
            return UserDefaults.standard.string(forKey: serverOverrideKey) != nil ? .custom : .builtin
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: envKey) }
    }

    /// 当前生效地址：按档解析。每次请求动态读取，改设置即时生效。
    static var baseURL: URL { url(for: env) }

    /// 展示用地址
    static var displayBaseURL: String { baseURL.absoluteString }

    /// 档对应地址；custom 档无有效自设地址时回落 builtin
    static func url(for serverEnv: ServerEnv) -> URL {
        switch serverEnv {
        case .builtin: return defaultBaseURL
        case .cloud:   return cloudBaseURL
        case .custom:  return customServerURL ?? defaultBaseURL
        }
    }

    /// 切档；非 custom 档顺手清掉自设地址，避免档与地址不一致
    static func setEnv(_ serverEnv: ServerEnv) {
        if serverEnv != .custom { UserDefaults.standard.removeObject(forKey: serverOverrideKey) }
        env = serverEnv
    }

    /// 用户自设地址（已规范化）；未设/非法返回 nil 回落默认
    static var customServerURL: URL? {
        guard let s = UserDefaults.standard.string(forKey: serverOverrideKey) else { return nil }
        return normalize(s)
    }

    /// 保存用户服务器地址并切到 custom 档；传空串恢复 builtin 档
    static func setCustomServer(_ raw: String) {
        guard let url = normalize(raw) else {
            UserDefaults.standard.removeObject(forKey: serverOverrideKey)
            env = .builtin
            return
        }
        UserDefaults.standard.set(url.absoluteString, forKey: serverOverrideKey)
        env = .custom
    }

    /// 规范化：自动补 scheme（缺省 http）、去尾斜杠；xiaozhi 端点在根路径故不追加 /api
    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s = String(s.dropLast()) }
        guard let url = URL(string: s), url.host != nil else { return nil }
        return url
    }

    static let requestTimeout: TimeInterval = 15
}
