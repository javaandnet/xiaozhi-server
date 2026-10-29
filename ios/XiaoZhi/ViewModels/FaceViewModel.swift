import Foundation
import SwiftUI
import UIKit

/// MasterPi 摄像头/人脸状态：预览流启停与三档模式、看家事件、人脸库、诱导式登记/追加、云台微调、人脸登录。
/// 预览流走免鉴权 /api/masterpi/stream/*（云端 hub 侧经 peer 转发家里执行）；登记/云台/登录走 /api/mcp/call 直调选中的机器人身体。
/// 画面源按 /health 的 peer.role 分流：在家→ Pi LAN 直连；外出（hub）→ 云端帧中继 + X-Peer-Key。
@MainActor
final class FaceViewModel: ObservableObject {
    /// 目标身体 device key（由机器人页选中的身体传入）
    let device: String

    /// 三档模式（与服务 Web 端 STREAM_MODES 同口径）
    static let modeOptions: [(value: String, label: String)] = [
        ("face", "人脸识别"), ("preview", "普通"), ("watch", "看家"),
    ]

    @Published var streamURL: String?          // 供 WKWebView 读的 MJPEG 地址（按 role 分流）
    @Published var streamRunning = false
    @Published var mode = "preview"            // 摄像头启动默认普通模式（识人/找人按钮会自动切 face）
    @Published var peerRole = ""               // /health 的互联角色；"hub"=连的云端
    @Published var watchEvents: [XZWatchEvent] = []
    @Published var watchImages: [String: UIImage] = [:]
    @Published var faces: [XZFacePerson] = []
    @Published var currentLogin: String?
    @Published var faceLoginEnabled = false
    @Published var threshold: Double?
    @Published var isBusy = false
    @Published var lastError: String?

    init(device: String) {
        self.device = device
    }

    var hasBody: Bool { !device.isEmpty }
    var isRemote: Bool { peerRole == "hub" }

    /// 帧中继需 X-Peer-Key；LAN 直连不需要
    var streamHeaders: [String: String] {
        isRemote ? ["X-Peer-Key": ClientSettings.peerKey] : [:]
    }

    // MARK: - 预览流

    /// 读 /health 判定当前连的是家里还是云端（决定画面源与鉴权方式）
    func detectRole() async {
        let h = try? await APIClient.shared.get(XZHealth.self, Endpoint.health)
        peerRole = h?.peer?.role ?? ""
    }

    /// 按角色拼画面源：hub→云端帧中继（需密钥）；否则 Pi LAN 直连
    private func resolvePreviewURL(_ st: XZStreamStatus?) -> String? {
        if isRemote {
            guard !ClientSettings.peerKey.isEmpty else {
                lastError = "外出看画面请在设置页填写互联密钥（peer.key）"
                return nil
            }
            guard let base = ClientSettings.baseURL else { return nil }
            return base.appendingPathComponent(Endpoint.peerCameraFeed).absoluteString
                + "?_=" + String(Int(Date().timeIntervalSince1970 * 1000))
        }
        return st?.streamURL
    }

    func refreshStream() async {
        if peerRole.isEmpty { await detectRole() }
        let st = try? await APIClient.shared.get(XZStreamStatus.self, Endpoint.faceStreamStatus)
        streamRunning = st?.running == true
        if let m = st?.mode, !m.isEmpty { mode = m }   // 派侧实况为准
        streamURL = streamRunning ? resolvePreviewURL(st) : nil
    }

    func startStream() async {
        guard hasBody else { lastError = "请先在机器人页选择身体"; return }
        isBusy = true; defer { isBusy = false }
        do {
            let st = try await APIClient.shared.postJSON(XZStreamStatus.self, Endpoint.faceStreamStart, json: ["mode": mode])
            streamRunning = st.running == true || st.ok == true
            if let m = st.mode, !m.isEmpty { mode = m }
            streamURL = streamRunning ? resolvePreviewURL(st) : nil
            if st.ok == false { lastError = st.error ?? "预览启动失败" }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func stopStream() async {
        isBusy = true; defer { isBusy = false }
        _ = try? await APIClient.shared.postJSON(XZAck.self, Endpoint.faceStreamStop, json: [:])
        streamRunning = false
        streamURL = nil
    }

    /// 运行中即时切档；未运行则只记住选择（启动时随 start 带上）
    func setMode(_ newMode: String) async {
        let prev = mode
        mode = newMode
        guard streamRunning, newMode != prev else { return }
        do {
            let r = try await APIClient.shared.postJSON(XZAck.self, Endpoint.faceStreamMode, json: ["mode": newMode])
            if r.ok == false {
                lastError = r.error ?? "模式切换失败"
                mode = prev
            } else {
                await refreshStream()   // 重建带时间戳的画面源，立刻反映新模式
            }
        } catch {
            lastError = error.localizedDescription
            mode = prev
        }
    }

    /// 识人/登记依赖人脸检测：流没跑先拉起（face 档），在跑但不在「人脸识别」档则切回（与 Web 端 ensureFaceMode 同口径）
    func ensureFaceMode() async {
        if !streamRunning {
            mode = "face"
            await startStream()
        } else if mode != "face" {
            await setMode("face")
        }
    }

    // MARK: - 看家事件

    func loadWatch() async {
        let r = try? await APIClient.shared.get(XZWatchEvents.self, Endpoint.watchEvents, query: ["since": "0"])
        watchEvents = Array((r?.events ?? []).suffix(12)).reversed()   // 最新在前
        // 异步拉快照（只拉展示中的前 6 张，免批量抓图）
        for ev in watchEvents.prefix(6) {
            guard let name = ev.shot, watchImages[name] == nil else { continue }
            watchImages[name] = await shotImage(name: name)
        }
    }

    /// 快照回读：走主通道 watch/shot（在家直连；云端 hub 经 peer 转发，均免鉴权）
    private func shotImage(name: String) async -> UIImage? {
        guard let base = ClientSettings.baseURL else { return nil }
        var comps = URLComponents(url: base.appendingPathComponent(Endpoint.watchShot), resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "name", value: name)]
        guard let u = comps?.url else { return nil }
        guard let (data, _) = try? await URLSession.shared.data(from: u) else { return nil }
        return UIImage(data: data)
    }

    // MARK: - 人脸库

    func loadFaces() async {
        let list = try? await APIClient.shared.get(XZFaceList.self, Endpoint.facesList)
        guard let list else { return }
        if list.ok == true {
            faces = list.persons ?? []
            currentLogin = list.currentLogin
            faceLoginEnabled = list.faceLoginEnabled == true
            threshold = list.threshold
        } else if let e = list.error {
            lastError = e
        }
    }

    /// 默认称呼：新人N（跳过已占用名）
    func defaultName() -> String {
        let taken = Set(faces.map { ($0.name ?? "").lowercased() })
        var k = faces.count + 1
        while taken.contains("新人\(k)".lowercased()) { k += 1 }
        return "新人\(k)"
    }

    // MARK: - 云台微调（诱导式对齐：边看预览边把镜头正对被登记者的脸）

    /// action: up/down/left/right/center
    func align(_ action: String) async -> String {
        guard hasBody else { return "✗ 请先选择身体" }
        isBusy = true; defer { isBusy = false }
        let label = ["up": "仰起", "down": "低头", "left": "左转", "right": "右转", "center": "回正"][action] ?? action
        do {
            let ack = try await callTool("robot_face_align", args: ["action": action])
            guard ack.ok == true else { return "✗ \(ack.error ?? "云台调整失败")" }
            if let r = ack.result, let d = r.data(using: .utf8),
               let res = try? JSONDecoder().decode(XZFaceAlignResult.self, from: d), res.ok == false {
                return "✗ \(res.error ?? "云台调整失败")"
            }
            return "✓ 云台已\(label)"
        } catch {
            return "✗ \(error.localizedDescription)"
        }
    }

    // MARK: - 诱导式登记 / 追加样本

    /// guided 采集：id 非空即为该成员追加样本（后端合并），否则新登记。
    /// 返回 (是否成功, 文案)。
    func enroll(name: String, appendToId: String?) async -> (Bool, String) {
        guard hasBody else { return (false, "身体离线，无法登记") }
        // 登记依赖人脸检测：当前不在 face 档则先自动切回
        if mode != "face", streamRunning { await setMode("face") }
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { return (false, "请填写称呼") }
        isBusy = true; defer { isBusy = false }
        let isAppend = appendToId?.isEmpty == false
        var args: [String: Any] = ["name": n, "guided": true]
        if let id = appendToId, !id.isEmpty { args["id"] = id }
        do {
            let ack = try await callTool("robot_face_enroll", args: args)
            guard ack.ok == true, let r = ack.result, let d = r.data(using: .utf8),
                  let res = try? JSONDecoder().decode(XZFaceEnrollResult.self, from: d) else {
                return (false, "✗ \(ack.error ?? "登记失败（未检到脸？请正对镜头重试）")")
            }
            if res.enrolled == true {
                await loadFaces()
                let msg = (isAppend ? "✓ 已为 " : "✓ 已登记：") + (res.name ?? n)
                    + "（ID \(res.id ?? "-")，现样本 \(res.samples ?? 0)）"
                return (true, msg)
            }
            return (false, "✗ \(res.error ?? res.reason ?? "采集失败（未检到脸？请正对镜头重试）")")
        } catch {
            return (false, "✗ \(error.localizedDescription)")
        }
    }

    // MARK: - 人脸登录

    func login() async -> String {
        guard hasBody else { return "✗ 请先选择身体" }
        isBusy = true; defer { isBusy = false }
        let ack = try? await callTool("robot_face_login", args: [:])
        guard let ack, ack.ok == true, let r = ack.result, let d = r.data(using: .utf8),
              let res = try? JSONDecoder().decode(XZFaceLoginResult.self, from: d) else {
            return "✗ \(ack?.error ?? "登录失败")"
        }
        await loadFaces()
        if res.logged_in == true { return "✓ 登录成功：\(res.name ?? "")（\(res.id ?? "")）" }
        return "未认出已登记的脸，请正对镜头重试"
    }

    func logout() async -> String {
        guard hasBody else { return "✗ 请先选择身体" }
        let ack = try? await callTool("robot_face_logout", args: [:])
        if ack?.ok == true { await loadFaces(); return "✓ 已退出登录" }
        return "✗ \(ack?.error ?? "退出失败")"
    }

    // MARK: - 内部

    private func callTool(_ tool: String, args: [String: Any]) async throws -> XZMcpCallAck {
        try await APIClient.shared.postJSON(XZMcpCallAck.self, Endpoint.mcpCall,
                                            json: ["device": device, "tool": tool, "args": args])
    }
}
