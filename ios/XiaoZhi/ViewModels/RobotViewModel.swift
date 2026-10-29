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
    // 硬件遥控（与 Web 游戏手柄同口径）
    @Published var chassisAllowed = false
    @Published var shuttingDown = false
    /// 机械臂微调末端坐标（仅供显示）：真基准在 server 端统一维护，每次 jog 回执后同步
    @Published var ikPose = IKPose(x: 0, y: 6, z: 18)

    struct IKPose {
        var x: Double
        var y: Double
        var z: Double
    }

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
        var args: [String: Any] = [:]
        let trimmed = argsJSON.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            guard let data = trimmed.data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                return "✗ args 不是合法 JSON 对象"
            }
            args = obj
        }
        return await callToolArgs(name, args)
    }

    /// 字典参数版直调（遥控按钮组用）
    func callToolArgs(_ name: String, _ args: [String: Any]) async -> String {
        let r = await callToolRaw(name, args)
        guard r.ok else { return "✗ \(r.error ?? "调用失败")" }
        return r.result ?? "✓ 已调用 \(name)"
    }

    /// 直调原始回执（识人/找人等需解析 result JSON 的场景用）
    func callToolRaw(_ name: String, _ args: [String: Any]) async -> (ok: Bool, result: String?, error: String?) {
        guard !selectedKey.isEmpty else { return (false, nil, "请先选择身体") }
        isBusy = true
        defer { isBusy = false }
        do {
            let ack = try await APIClient.shared.postJSON(XZMcpCallAck.self, Endpoint.mcpCall,
                                                          json: ["device": selectedKey, "tool": name, "args": args])
            return (ack.ok == true, ack.result, ack.error)
        } catch let e as APIError {
            return (false, nil, e.errorDescription ?? "请求失败")
        } catch {
            return (false, nil, error.localizedDescription)
        }
    }

    // MARK: - 硬件遥控（底盘/头部/机械臂，参数与 Web RobotGamepad 一致）

    func loadSafety() async {
        let r = try? await APIClient.shared.get(XZSafetyAck.self, Endpoint.masterpiSafety)
        if r?.ok == true { chassisAllowed = r?.allowChassis == true }
    }

    func setChassis(_ allow: Bool) async {
        isBusy = true; defer { isBusy = false }
        let r = try? await APIClient.shared.postJSON(XZSafetyAck.self, Endpoint.masterpiSafety,
                                                     json: ["allowChassis": allow])
        if r?.ok == true {
            chassisAllowed = r?.allowChassis == true
        } else {
            chassisAllowed.toggle()   // 回滚 Toggle
            reply = "✗ \(r?.error ?? "底盘授权切换失败")"
        }
    }

    /// 底盘：dir=forward/backward/left/right/turn_left/turn_right；stop=急停免确认
    func drive(_ dir: String) async -> String {
        if dir == "stop" { return await callToolArgs("robot_drive", ["direction": "stop"]) }
        // 原地转角速度固定，角度正比于时长：转角缩到 1/4（0.6s → 0.15s，与 Web 端同口径）
        let dur: Double = dir.hasPrefix("turn_") ? 0.15 : 0.6
        return await callToolArgs("robot_drive", ["direction": dir, "duration_sec": dur, "speed": 0.3])
    }

    /// 头部云台：up/down/left/right（步进 100）
    func pan(_ action: String) async -> String {
        await callToolArgs("robot_face_align", ["action": action, "step": 100])
    }

    /// 机械臂姿势
    func arm(_ pose: String) async -> String {
        await callToolArgs("robot_arm_pose", ["pose": pose])
    }

    /// 机械臂末端微调（IK jog）：只发方向语义，基准/符号/安全盒全部由 server 统一维护
    /// （与 Web 共用一份，避免本地跟踪陈旧导致“先跳回某位再动”；连续动作后须先回位）
    func ikJog(_ dir: String) async -> String {
        guard !selectedKey.isEmpty else { return "✗ 请先选择身体" }
        isBusy = true
        defer { isBusy = false }
        do {
            let ack = try await APIClient.shared.postJSON(XZIkJogAck.self, Endpoint.masterpiIkJog,
                                                          json: ["body": selectedKey, "dir": dir])
            if ack.ok == true, let p = ack.pose {
                ikPose = IKPose(x: p.x, y: p.y, z: p.z)
                return "✓ 微调到位 (\(ikPose.x), \(ikPose.y), \(ikPose.z))cm"
            }
            return "✗ \(ack.error ?? "微调失败")"
        } catch let e as APIError {
            return "✗ \(e.errorDescription ?? "请求失败")"
        } catch {
            return "✗ \(error.localizedDescription)"
        }
    }

    /// 重连身体：server 经 SSH 重启派侧 client。用于 server 重启后身体僵尸假在线
    /// （相机正常但云台/微调报无法连接）的一键自愈。
    func reconnectBody() async -> String {
        isBusy = true
        defer { isBusy = false }
        do {
            let ack = try await APIClient.shared.postJSON(XZReconnectAck.self, Endpoint.masterpiReconnect,
                                                          json: [:])
            if ack.ok == true {
                return "✓ 已重启身体客户端（\(ack.active ?? "active")），约 10 秒后重新接入"
            }
            return "✗ \(ack.error ?? "重连失败")"
        } catch let e as APIError {
            return "✗ \(e.errorDescription ?? "请求失败")"
        } catch {
            return "✗ \(error.localizedDescription)"
        }
    }

    // MARK: - 识人 / 找人（读派侧 JSON 结果里的 person 字段）

    /// 识人：只看当前画面认是谁（不运动）
    func faceRecognize() async -> String {
        let r = await callToolRaw("robot_face_recognize", [:])
        guard r.ok, let res = decodeResult(r.result) else { return "✗ 识人：\(r.error ?? "失败")" }
        if res["ok"] as? Bool == false { return "✗ 识人：\(res["error"] as? String ?? "失败")" }
        if let p = res["person"] as? String {
            let pid = res["person_id"] as? String ?? "-"
            return "🧑 这是「\(p)」（\(pid)）"
        }
        return "没匹配到已登记的人（镜头里没脸或陌生人）"
    }

    /// 找人：巡视寻脸→对准→识人（只动头/躯干不碰轮子）；填了名字则比对结果
    func searchFace(name: String) async -> String {
        let r = await callToolRaw("robot_search_face", ["max_scan_sec": 20])
        guard r.ok, let res = decodeResult(r.result) else { return "✗ 找人：\(r.error ?? "失败")" }
        if res["ok"] as? Bool == false { return "✗ 找人：\(res["error"] as? String ?? "失败")" }
        guard res["found"] as? Bool == true else { return "🔍 转了一圈没找到人，可再点重扫" }
        let p = res["person"] as? String
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if n.isEmpty {
            return p != nil ? "✓ 找到人：是「\(p!)」，已对准停下" : "✓ 找到人（陌生人），已对准停下"
        }
        if let p, p.lowercased() == n.lowercased() { return "✓ 找到「\(n)」，已停止并对准镜头" }
        return p != nil ? "找到的那个人是「\(p!)」，不是「\(n)」（可再扫）"
                        : "找到一个人但没认出是谁，不是「\(n)」（可再扫）"
    }

    private func decodeResult(_ raw: String?) -> [String: Any]? {
        guard let raw, let d = raw.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }

    /// 发送语音（文字投递）：与 Web 端游戏手柄 /api/masterpi/speak 同口径，
    /// 收件小智由服务端按一一对应绑定（settings.robot.body）倒查，本机不手选；待机先唤醒再朗读。
    func speak(text: String) async -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return "✗ 先输入要播报的文字" }
        guard !selectedKey.isEmpty else { return "✗ 请先选择身体" }
        isBusy = true
        defer { isBusy = false }
        do {
            let ack = try await APIClient.shared.postJSON(XZSpeakAck.self, Endpoint.masterpiSpeak,
                                                          json: ["text": t, "body": selectedKey])
            if ack.ok == true {
                return "✓ 播报已排队 → \(ack.deviceId ?? "\(ack.devices ?? 0) 台绑定设备")（设备唤醒后朗读）"
            }
            return "✗ \(ack.error ?? "播报失败")"
        } catch let e as APIError {
            return "✗ \(e.errorDescription ?? "请求失败")"
        } catch {
            return "✗ \(error.localizedDescription)"
        }
    }

    /// 软关机：SSH shutdown -h；关机后需按物理电源，电池机型请顺手断开扩展板开关。
    func shutdown() async -> String {
        shuttingDown = true; defer { shuttingDown = false }
        do {
            let r = try await APIClient.shared.postJSON(XZAck.self, Endpoint.masterpiShutdown, json: [:])
            if r.ok == true {
                return "✓ 关机指令已发出，设备数十秒内停止；再开机需按物理电源键（电池供电时关机后请关闭扩展板开关，避免待机耗电）"
            }
            return "✗ \(r.error ?? "关机失败")"
        } catch let e as APIError {
            return "✗ \(e.errorDescription ?? "关机失败")"
        } catch {
            return "✗ \(error.localizedDescription)"
        }
    }
}
