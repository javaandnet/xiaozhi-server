import Foundation

/// 统一网络层。约定（与 xiaozhi-server index.js setupRoutes 对齐）：
/// - 简单控制端点免鉴权；`/api/voice/*` 需带 `X-Xiaozhi-Key == config.voiceFlow.token`；
/// - 成功：HTTP 2xx，body 直接是业务 JSON（无统一 {success,data} 信封）；
/// - 失败：HTTP 4xx/5xx + `{ success/ok:false, error:"文案" }`，抛 APIError；
/// - 401/403 视为密钥问题，单独提示。
final class APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    private init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = AppConfig.requestTimeout
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: cfg)
    }

    private func makeRequest(_ method: String, _ path: String, query: [String: String]?,
                             body: Data?, needsKey: Bool) throws -> URLRequest {
        // 非隔离读取层：网络层跑在 URLSession 后台 executor，不碰 @MainActor 实例
        guard let base = ClientSettings.baseURL else {
            throw APIError.httpStatus(0, "请先在设置页填写服务地址")
        }
        var url = base.appendingPathComponent(path)
        if let query, !query.isEmpty {
            var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
            url = comps.url!
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if needsKey {
            let key = ClientSettings.voiceKey
            if !key.isEmpty { req.setValue(key, forHTTPHeaderField: "X-Xiaozhi-Key") }
        }
        req.httpBody = body
        return req
    }

    /// 发起请求并解码为 T。T == EmptyResponse 时不解析 body。
    func send<T: Decodable>(_ type: T.Type, method: String, path: String,
                            query: [String: String]? = nil,
                            body: (any Encodable)? = nil) async throws -> T {
        let payload: Data? = body.flatMap { try? encoder.encodeAny($0) }
        return try await sendRaw(type, method: method, path: path, query: query, payload: payload)
    }

    /// 以已编码好的 JSON Data 作为请求体（供 /api/mcp/call 传任意 tool args）。
    func sendRaw<T: Decodable>(_ type: T.Type, method: String, path: String,
                               query: [String: String]? = nil,
                               payload: Data?) async throws -> T {
        let req = try makeRequest(method, path, query: query, body: payload,
                                  needsKey: Endpoint.requiresVoiceKey(path))
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch let urlErr as URLError {
            if urlErr.code == .cancelled { throw APIError.cancelled }
            throw APIError.network(urlErr)
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.invalidResponse }
        if (200..<300).contains(http.statusCode) {
            if type == EmptyResponse.self { return EmptyResponse() as! T }
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw APIError.decoding(error)
            }
        }
        let msg = (try? decoder.decode(APIErrorBody.self, from: data))?.message
        if http.statusCode == 401 || http.statusCode == 403 { throw APIError.unauthorized }
        throw APIError.httpStatus(http.statusCode, msg ?? "HTTP \(http.statusCode)")
    }

    // MARK: - 便捷方法

    func get<T: Decodable>(_ type: T.Type, _ path: String, query: [String: String]? = nil) async throws -> T {
        try await send(type, method: "GET", path: path, query: query)
    }

    func post<T: Decodable>(_ type: T.Type, _ path: String, body: (any Encodable)? = nil) async throws -> T {
        try await send(type, method: "POST", path: path, body: body)
    }

    /// 以 JSONSerialization 将字典（可含嵌套/任意类型）编码后 POST。
    func postJSON<T: Decodable>(_ type: T.Type, _ path: String, json: [String: Any]) async throws -> T {
        let payload = try? JSONSerialization.data(withJSONObject: json)
        return try await sendRaw(type, method: "POST", path: path, payload: payload)
    }
}

extension JSONEncoder {
    /// 擦除泛型编码：把 `some Encodable` 按具体类型编码
    func encodeAny<T: Encodable>(_ value: T) throws -> Data {
        try encode(value)
    }
}
