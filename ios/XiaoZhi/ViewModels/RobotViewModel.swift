import Foundation
import SwiftUI

/// 机器人（MasterPi / device-MCP 身体）状态：列在线身体、拉某身体工具、发自然语言指令或直调工具。
@MainActor
final class RobotViewModel: ObservableObject {
    @Published var robots: [XZMcpProvider] = []
    @Published var selectedKey: String = ""
    @Published var tools: [XZMcpTool] = []
    @Published var actions: [XZRobotAction] = []
    @Published var commandText: String = ""
    @Published var reply: String?
    @Published var isBusy = false
    @Published var isLoaded = false
    @Published var errorMessage: String?

    var selectedRobot: XZMcpProvider? { robots.first { $0.key == selectedKey } }
    var hasRobot: Bool { !robots.isEmpty }

    func refresh() async {
        do {
            let st = try await APIClient.shared.get(XZMcpStatus.self, Endpoint.mcpStatus)
            robots = (st.providers ?? []).filter { $0.isRobot }
            // 选中项失效时自动挑一台就绪身体，否则取第一台
            if selectedRobot == nil {
                selectedKey = (robots.first { $0.isReady } ?? robots.first)?.key ?? ""
            }
            errorMessage = nil
            if selectedKey.isEmpty { tools = [] } else { await loadTools(selectedKey) }
        } catch let e as APIError {
            if !e.isCancelled { errorMessage = e.errorDescription }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoaded = true
    }

    /// 动作目录只在首次进入时拉一次（静态参考）
    func loadActionsIfNeeded() async {
        guard actions.isEmpty else { return }
        let catalog = try? await APIClient.shared.get(XZRobotActionCatalog.self, Endpoint.robotActionTypes)
        actions = catalog?.items ?? []
    }

    func loadTools(_ device: String) async {
        guard !device.isEmpty else { tools = []; return }
        let list = try? await APIClient.shared.get(XZMcpToolList.self, Endpoint.mcpTools,
                                                   query: ["device": device])
        tools = list?.tools ?? []
    }

    func select(_ key: String) async {
        selectedKey = key
        isBusy = true
        await loadTools(key)
        isBusy = false
    }

    /// 自然语言 → LLM 分析 → 定向执行该身体工具（speak 控制是否经小智播报回复）
    func sendCommand(speak: Bool = true) async {
        let text = commandText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !selectedKey.isEmpty else {
            reply = "请先选择身体并输入指令"; return
        }
        isBusy = true; reply = nil
        defer { isBusy = false }
        let body: [String: Any] = ["device": selectedKey, "text": text, "speak": speak, "kind": "voice"]
        do {
            let ack = try await APIClient.shared.postJSON(XZDeviceCommandAck.self, Endpoint.deviceCommand, json: body)
            if ack.ok == true {
                reply = ack.reply ?? "指令已执行"
            } else {
                reply = "✗ \(ack.error ?? "执行失败")"
            }
        } catch let e as APIError {
            reply = "✗ \(e.errorDescription ?? "请求失败")"
        } catch {
            reply = "✗ \(error.localizedDescription)"
        }
    }

    /// 直调某工具（绕过 LLM），args 为 JSON 对象字符串，留空即 {}
    func callTool(name: String, argsJSON: String) async -> String {
        guard !selectedKey.isEmpty else { return "请先选择身体" }
        var args: [String: Any] = [:]
        let trimmed = argsJSON.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            guard let data = trimmed.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                return "✗ args 不是合法 JSON 对象"
            }
            args = obj
        }
        isBusy = true
        defer { isBusy = false }
        do {
            let ack = try await APIClient.shared.postJSON(XZMcpCallAck.self, Endpoint.mcpCall,
                                                          json: ["device": selectedKey, "tool": name, "args": args])
            return (ack.ok == true) ? (ack.result ?? "✓ 已调用 \(name)") : "✗ \(ack.error ?? "调用失败")"
        } catch let e as APIError {
            return "✗ \(e.errorDescription ?? "请求失败")"
        } catch {
            return "✗ \(error.localizedDescription)"
        }
    }
}
