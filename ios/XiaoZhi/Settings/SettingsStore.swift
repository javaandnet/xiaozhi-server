import Foundation
import Combine

/// 用户可改的运行配置（可在手机上直接覆盖构建期默认值）：
/// - serverEnv ：接入环境档（局域网 / 公网服务器 / 自定义），存 UserDefaults；
/// - customServer：自定义档手填地址（切到 custom 即生效）；
/// - voiceKey ：对应服务端 config.voiceFlow.token，用于 /api/voice/* 鉴权，存 Keychain。
/// - peerKey ：对应服务端 config.peer.key，外出（连云端 hub）时相机帧中继鉴权用，存 Keychain。
/// 地址与档位的持久化、解析全部收口到 AppConfig，本类只做 UI 绑定与即时回读。
@MainActor
final class SettingsStore: ObservableObject {
    static let shared = SettingsStore()

    @Published var serverEnv: AppConfig.ServerEnv
    @Published var customServer: String
    @Published var voiceKey: String {
        didSet {
            if voiceKey.isEmpty { KeychainStore.delete(account: "voiceKey") }
            else { KeychainStore.set(account: "voiceKey", value: voiceKey) }
        }
    }
    @Published var peerKey: String {
        didSet {
            if peerKey.isEmpty { KeychainStore.delete(account: "peerKey") }
            else { KeychainStore.set(account: "peerKey", value: peerKey) }
        }
    }

    private init() {
        serverEnv = AppConfig.env
        customServer = AppConfig.customServerURL?.absoluteString ?? ""
        voiceKey = KeychainStore.get(account: "voiceKey") ?? ""
        peerKey = KeychainStore.get(account: "peerKey") ?? ""
    }

    /// 当前生效服务根地址（不含尾斜杠），按档解析
    var resolvedBaseURL: URL? { AppConfig.baseURL }
    /// 展示用当前生效地址
    var displayBaseURL: String { AppConfig.displayBaseURL }

    /// 一键切档：写穿 AppConfig 并回读，保证档与自设地址一致
    func selectEnv(_ env: AppConfig.ServerEnv) {
        AppConfig.setEnv(env)
        serverEnv = AppConfig.env
        customServer = AppConfig.customServerURL?.absoluteString ?? ""
    }

    /// 保存自定义地址：合法则切 custom 档，空/非法回落 builtin；随后回读刷新绑定
    func saveCustom(_ raw: String) {
        AppConfig.setCustomServer(raw)
        serverEnv = AppConfig.env
        customServer = AppConfig.customServerURL?.absoluteString ?? ""
    }

    func resetToDefault() {
        AppConfig.setEnv(.builtin)
        AppConfig.setCustomServer("")
        voiceKey = ""
        peerKey = ""
        serverEnv = AppConfig.env
        customServer = ""
    }
}

/// 非隔离设置读取层：网络层跑在 URLSession 后台 executor，不得访问 @MainActor 实例；
/// AppConfig 的解析全走 UserDefaults（线程安全），故两边共用。
enum ClientSettings {
    static var voiceKey: String {
        KeychainStore.get(account: "voiceKey") ?? ""
    }

    /// 互联密钥：外出读云端帧中继画面时作为 X-Peer-Key 头下发
    static var peerKey: String {
        KeychainStore.get(account: "peerKey") ?? ""
    }

    /// 当前生效服务根地址（按档动态解析，改设置即时生效）
    static var baseURL: URL? { AppConfig.baseURL }
}
