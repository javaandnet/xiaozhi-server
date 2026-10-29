import SwiftUI

/// 机器人设定页（传统 iOS 竖屏 List）：选身体/底盘授权/遥控入口/人脸登记/自然语言指令/直调工具/软关机。
/// 硬件遥控按钮组已拆到横屏操作页 RobotConsoleView。
struct RobotView: View {
    @ObservedObject var vm: RobotViewModel
    @State private var showFaceEnroll = false
    @State private var showShutdownAlert = false
    @State private var ctrlReply: String?

    var body: some View {
        NavigationStack {
            List {
                bodySection
                consoleSection
                commandSection
                toolsSection
                referenceSection
            }
            .listStyle(.insetGrouped)
            .navigationTitle("机器人")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showFaceEnroll = true
                    } label: {
                        Label("人脸登记", systemImage: "person.crop.circle.badge.plus")
                    }
                    .disabled(vm.selectedKey.isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { ctrlReply = await vm.reconnectBody() }
                    } label: {
                        Label("重连身体", systemImage: "cable.connector")
                    }
                    .disabled(vm.isBusy)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showShutdownAlert = true
                    } label: {
                        Label("关机", systemImage: vm.shuttingDown ? "hourglass" : "power")
                    }
                    .disabled(vm.selectedKey.isEmpty || vm.shuttingDown)
                }
            }
            .sheet(isPresented: $showFaceEnroll) {
                FaceEnrollView(vm: FaceViewModel(device: vm.selectedKey))
            }
            .confirmationDialog("确认关机？系统将安全停止后断电，需按设备上物理电源键才能重新开机。\n电池供电时：关机后请再关闭扩展板开关，否则待机电流会持续放干电池致过放无法开机。",
                                isPresented: $showShutdownAlert, titleVisibility: .visible)
            {
                Button("关机", role: .destructive) {
                    Task { ctrlReply = await vm.shutdown() }
                }
                Button("取消", role: .cancel) {}
            }
            .refreshable { await vm.refresh() }
            .task {
                if !vm.isLoaded { await vm.refresh() }
                await vm.loadActionsIfNeeded()
                await vm.loadSafety()
            }
        }
    }

    private func run(_ text: String) {
        ctrlReply = text
    }

    // MARK: - 身体选择

    @ViewBuilder private var bodySection: some View {
        Section {
            if vm.robots.isEmpty {
                Label(vm.errorMessage ?? "没有检测到机器人身体（device-MCP）", systemImage: "questionmark.circle")
                    .foregroundStyle(.secondary)
            } else {
                Picker("身体", selection: Binding(
                    get: { vm.selectedKey },
                    set: { key in Task { await vm.select(key); await vm.loadSafety() } }
                )) {
                    ForEach(vm.robots) { r in
                        HStack {
                            Text("\(r.displayName)（\(r.isReady ? "就绪" : "未就绪")·\(r.toolCount ?? 0) 工具）")
                        }.tag(r.key)
                    }
                }
                .pickerStyle(.menu)
                if let r = vm.selectedRobot {
                    Text("device: \(r.key)").font(.caption2).foregroundStyle(.secondary)
                }
            }
        } header: {
            HStack {
                Text("机器人身体 · \(vm.robots.count) 台")
                Spacer()
                Button("刷新") { Task { await vm.refresh() } }.font(.caption)
            }
        }
    }

    // MARK: - 遥控入口（横屏操作页）

    private var consoleSection: some View {
        Section {
            NavigationLink {
                RobotConsoleView(vm: vm)
            } label: {
                HStack {
                    Label("遥控操作（横屏）", systemImage: "gamecontroller.fill")
                    Spacer()
                    Text(vm.selectedKey.isEmpty ? "无在线身体" : "🎮")
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(vm.selectedKey.isEmpty)

            if let r = ctrlReply {
                Text(r).font(.caption)
                    .foregroundStyle(r.hasPrefix("✗") ? .red : .secondary)
                    .textSelection(.enabled)
            }
        } header: { Text("遥控") }
        footer: {
            Text("底盘解锁（轮子解锁）在遥控页内操作。")
                .font(.footnote)
        }
    }

    // MARK: - 指令 / 工具 / 参考

    private var commandSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                TextField("用自然语言下指令，如「挥挥手」「向前走了吗」", text: $vm.commandText, axis: .vertical)
                    .lineLimit(1...3)
                    .disabled(vm.selectedKey.isEmpty)
                Button {
                    Task { await vm.sendCommand() }
                } label: {
                    HStack {
                        Text(vm.isBusy ? "执行中…" : "发送指令")
                        Spacer()
                        Image(systemName: "paperplane.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(vm.isBusy || vm.selectedKey.isEmpty || vm.commandText.trimmed.isEmpty)
                if let reply = vm.reply {
                    Text(reply).font(.callout)
                        .foregroundStyle(reply.hasPrefix("✗") ? .red : .primary)
                        .textSelection(.enabled)
                }
            }
        } header: { Text("指令（经 LLM 定向执行）") }
        footer: { Text("小智会把回复文本经语音设备播报（TTS 走小智，不推给身体）。").font(.footnote) }
    }

    private var toolsSection: some View {
        Section {
            if vm.tools.isEmpty {
                Text(vm.selectedKey.isEmpty ? "请先选择身体" : "该身体未上报可直调工具")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(vm.tools) { tool in
                    ToolRow(vm: vm, tool: tool)
                }
            }
        } header: {
            Text("可直调工具 · \(vm.tools.count)（绕过 LLM）")
        }
    }

    private var referenceSection: some View {
        Section {
            DisclosureGroup("动作类型目录（\(vm.actions.count)）") {
                ForEach(vm.actions) { a in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(a.label ?? a.id ?? "-").fontWeight(.medium)
                            if a.physical == true {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .font(.caption2).foregroundStyle(.orange)
                            }
                            if a.wired == false {
                                Text("未接线").font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(a.categoryLabel ?? a.category ?? "").font(.caption2).foregroundStyle(.secondary)
                        }
                        if let args = a.args, !args.isEmpty {
                            Text(args).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 1)
                }
            }
        } header: { Text("参考") }
    }
}

/// 单工具行：可展开填 args(JSON) 后直调，显示结果
private struct ToolRow: View {
    @ObservedObject var vm: RobotViewModel
    let tool: XZMcpTool
    @State private var expanded = false
    @State private var args = ""
    @State private var result: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation { expanded.toggle() }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(tool.displayName).font(.system(.body, design: .monospaced))
                        if let d = tool.description, !d.isEmpty {
                            Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

            if expanded {
                TextField("args JSON，如 {\"pose\":\"wave\"}（留空={})", text: $args, axis: .vertical)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(1...4)
                    .autocorrectionDisabled()
                HStack {
                    Button("调用") {
                        Task { result = await vm.callTool(name: tool.displayName, argsJSON: args) }
                    }
                    .disabled(vm.isBusy)
                    Spacer()
                }
                if let result {
                    Text(result).font(.caption)
                        .foregroundStyle(result.hasPrefix("✗") ? .red : .secondary)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
