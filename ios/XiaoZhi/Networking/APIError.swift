import Foundation

/// 统一错误类型，面向中文界面。xiaozhi-server 各端点错误体不统一：
/// - REST 控制端点：`{ success:false, error:"文案" }` 或 `{ ok:false, error:"文案" }`；
/// - 少数老端点：`{ error:"文案" }`。故 error 字段兼容字符串与缺省两种形态。
enum APIError: LocalizedError {
    case invalidResponse
    case httpStatus(Int, String?)
    case unauthorized
    case decoding(Error)
    case network(Error)
    case cancelled

    var isCancelled: Bool {
        if case .cancelled = self { return true }
        if case .network(let e) = self, (e as? URLError)?.code == .cancelled { return true }
        return false
    }

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "收到无法识别的响应"
        case .httpStatus(let code, let msg): return msg ?? "请求失败（HTTP \(code)）"
        case .unauthorized: return "鉴权失败：请在设置页检查语音流程密钥（voiceFlow.token）"
        case .decoding: return "数据解析失败，请确认服务端版本"
        case .network: return "网络连接异常，请检查服务地址与网络"
        case .cancelled: return "已取消"
        }
    }
}

/// 后端错误信封：兼容 { error:"文案" } 与 { success/ok:false, error:"文案" }
struct APIErrorBody: Decodable {
    struct Payload: Decodable {
        let raw: String
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self) { raw = s; return }
            raw = "请求失败"
        }
    }
    let error: Payload?
    var message: String? { error?.raw }
}

struct EmptyResponse: Decodable {
    init() {}
    init(from decoder: Decoder) {}
}
