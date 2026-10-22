import Foundation
import SwiftUI

/// MasterPi 人脸登记状态：摄像头 MJPEG 预览启停、人脸库列表、诱导式登记/追加、云台微调、人脸登录。
/// 预览流走免鉴权 /api/masterpi/stream/*；登记/云台/登录走 /api/mcp/call 直调选中的机器人身体。
@MainActor
final class FaceViewModel: ObservableObject {
    /// 目标身体 device key（由机器人页选中的身体传入）
    let device: String

    @Published var streamURL: String?          // 供 WKWebView 直读的 MJPEG 地址
    @Published var streamRunning = false
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

    // MARK: - 预览流

    func refreshStream() async {
        let st = try? await APIClient.shared.get(XZStreamStatus.self, Endpoint.faceStreamStatus)
        streamRunning = st?.running == true
        if streamRunning, let u = st?.streamURL { streamURL = u }
    }

    func startStream() async {
        guard hasBody else { lastError = "请先在机器人页选择身体"; return }
        isBusy = true; defer { isBusy = false }
        do {
            let st = try await APIClient.shared.postJSON(XZStreamStatus.self, Endpoint.faceStreamStart, json: [:])
            streamRunning = st.running == true || st.ok == true
            if let u = st.streamURL { streamURL = u }
            if st.ok == false { lastError = st.error ?? "预览启动失败" }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func stopStream() async {
        isBusy = true; defer { isBusy = false }
        _ = try? await APIClient.shared.postJSON(XZStreamStatus.self, Endpoint.faceStreamStop, json: [:])
        streamRunning = false
        streamURL = nil
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
