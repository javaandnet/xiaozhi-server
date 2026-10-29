import SwiftUI

/// 设备详情设定页：基础信息 + 播报/命令/唤醒 + 能力设定（机器人硬件/身体绑定、智能家居、语言）。
/// 读写 GET/POST /api/settings/device；后端字段级合并（robot 只回传 enabled/body，actions/maxFunctions 保持原值）。
/// 播报/命令/唤醒仅对在线设备开放（vm 轮询保持状态实时）。
struct DeviceDetailView: View {
    let device: XZKnownDevice
    @ObservedObject var vm: DevicesViewModel

    // 设定状态
    @State private var loaded = false
    @State private var isLoading = false
    @State private var saving = false
    @State private var message: String?

    // 播报/命令状态
    @State private var text: String = ""
    @State private var sending = false

    @State private var robotEnabled = false
    @State private var robotBody = ""          // "" = 未绑定（回退全局）
    @State private var homeEnabled = false
    @State private var language = ""           // "" = 跟随全局

    // 可绑定的机器人身体（device-MCP provider）
    @State private var bodies: [XZMcpProvider] = []

    /// 实时在线状态：从 vm 轮询列表取最新行，回落到进入时的快照
    private var liveDevice: XZKnownDevice {
        vm.knownDevices.first { $0.keyId == device.keyId } ?? device
    }
    private var isOnline: Bool { liveDevice.isOnline }

    var body: some View {
        List {
            infoSection
            controlSection
            capabilitySection
            languageSection
            if let message {
                Text(message).font(.callout)
                    .foregroundStyle(message.hasPrefix("✗") ? .red : .primary)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(device.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await loadSettings()
            await loadBodies()
        }
    }

    // MARK: - 设备信息

    private var infoSection: some View {
        Section {
            infoRow("状态") {
                StatusBadge(kind: isOnline ? .online : (liveDevice.isResting ? .resting : .offline))
            }
            infoRow("Device ID", value: device.device_id ?? "-")
            if let mac = device.mac, !mac.isEmpty { infoRow("MAC", value: mac) }
            if let ip = device.ip, !ip.isEmpty { infoRow("IP", value: ip) }
            if let model = device.model, !model.isEmpty { infoRow("型号", value: model) }
            if let type = device.type, !type.isEmpty { infoRow("类型", value: type) }
            infoRow("最后在线", value: xzRelativeTime(device.last_seen))
        } header: { Text("设备信息") }
    }

    private func infoRow<V: View>(_ label: String, value: String? = nil,
                                  @ViewBuilder content: () -> V = { EmptyView() }) -> some View {
        HStack {
            Text(label)
            Spacer()
            if let value {
                Text(value).foregroundStyle(.secondary).textSelection(.enabled)
            } else {
                content()
            }
        }
    }

    // MARK: - 播报 / 命令 / 唤醒（仅在线设备可用）

    private var controlSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                TextEditor(text: $text)
                    .frame(minHeight: 72)
                    .font(.body)
                    .disabled(!isOnline)
                    .overlay(alignment: .topLeading) {
                        if text.isEmpty {
                            Text(isOnline ? "要播报给它的文字 / 自然语言命令…" : "设备离线，无法发送信息")
                                .foregroundStyle(.tertiary)
                                .padding(.top, 8).padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                    }

                HStack(spacing: 10) {
                    Button {
                        Task {
                            sending = true
                            await vm.broadcast(text: text, deviceId: device.keyId)
                            sending = false
                        }
                    } label: {
                        Label(sending ? "发送中…" : "播报", systemImage: "speaker.wave.2.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                    .disabled(!isOnline || sending || text.trimmed.isEmpty)

                    Button {
                        Task {
                            sending = true
                            await vm.command(text: text, deviceId: device.keyId)
                            sending = false
                        }
                    } label: {
                        Label("命令", systemImage: "text.bubble.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                    .disabled(!isOnline || sending || text.trimmed.isEmpty)

                    Button {
                        Task {
                            sending = true
                            await vm.wake(deviceId: device.keyId)
                            sending = false
                        }
                    } label: {
                        Label("唤醒", systemImage: "bell.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.large)
                    .disabled(!isOnline || sending)
                }

                if let msg = vm.actionMessage {
                    Text(msg).font(.footnote).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
        } header: { Text("播报 / 命令 / 唤醒") } footer: {
            Text(isOnline
                 ? "命令相当于对它说话（设备处理后语音回复）；唤醒用于退出休息模式并提示它听。"
                 : "设备当前离线，仅可查看/修改设定；上线后即可发送信息。")
                .font(.footnote)
        }
    }

    // MARK: - 能力设定

    private var capabilitySection: some View {
        Section {
            Toggle("支持机器人硬件", isOn: $robotEnabled)
            if robotEnabled {
                Picker("绑定身体", selection: $robotBody) {
                    Text("未绑定（回退全局）").tag("")
                    ForEach(bodies) { b in
                        Text("\(b.displayName)（\(b.isReady ? "就绪" : "未就绪")）").tag(b.key)
                    }
                }
                .pickerStyle(.menu)
            }
            Toggle("支持智能家居", isOn: $homeEnabled)
        } header: {
            HStack {
                Text("能力设定")
                Spacer()
                Button(saving ? "保存中…" : "保存") { Task { await save() } }
                    .font(.caption)
                    .disabled(saving || !loaded)
            }
        } footer: {
            Text("机器人硬件：会话注入身体人设与动作工具；智能家居：会话注入 HomeKit 灯具工具。保存后立即热更在线会话。")
                .font(.footnote)
        }
    }

    private var languageSection: some View {
        Section {
            Picker("语言", selection: $language) {
                Text("跟随全局").tag("")
                Text("中文").tag("zh")
                Text("日本語").tag("ja")
                Text("English").tag("en")
            }
            .pickerStyle(.menu)
        } header: { Text("语音") }
        footer: { Text("LLM 回复/欢迎语/TTS 音色语种；个体设定优先于全局默认。") }
    }

    // MARK: - 读写

    private func loadSettings() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let env = try await APIClient.shared.get(
                XZDeviceSettingsEnvelope.self, Endpoint.settingsDevice,
                query: ["deviceId": device.keyId])
            guard env.ok == true else {
                message = "✗ \(env.error ?? "读取设定失败")"; return
            }
            let s = env.settings ?? XZDeviceSettings()
            robotEnabled = s.robot?.enabled == true
            robotBody = s.robot?.body ?? ""
            homeEnabled = s.home?.enabled == true
            language = s.language ?? ""
            loaded = true
        } catch {
            message = "✗ \(error.localizedDescription)"
        }
    }

    private func loadBodies() async {
        let st = try? await APIClient.shared.get(XZMcpStatus.self, Endpoint.mcpStatus)
        bodies = (st?.providers ?? []).filter { $0.isRobot }
    }

    private func save() async {
        saving = true; message = nil
        defer { saving = false }
        var body: [String: Any] = ["deviceId": device.keyId]
        // language："" = 跟随全局（后端按空串清除个体设定）
        body["language"] = language
        // robot 只回传 enabled/body：actions/maxFunctions 后端保持原值
        var robot: [String: Any] = ["enabled": robotEnabled]
        robot["body"] = robotBody          // "" = 解绑回退全局
        body["robot"] = robot
        body["home"] = ["enabled": homeEnabled]
        do {
            let ack = try await APIClient.shared.postJSON(XZDeviceSettingsAck.self,
                                                          Endpoint.settingsDevice, json: body)
            if ack.ok == true {
                message = "✓ 已保存并热更在线会话"
            } else {
                message = "✗ \(ack.error ?? "保存失败")"
            }
        } catch {
            message = "✗ \(error.localizedDescription)"
        }
    }
}
