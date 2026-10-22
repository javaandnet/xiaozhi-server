import SwiftUI

/// 设备面板：服务状态 + 播报/唤醒控制台 + 已登记设备（含在线/休息/离线状态）。
struct DeviceListView: View {
    @ObservedObject var vm: DevicesViewModel

    @State private var text: String = ""
    @State private var targetId: String = ""     // "" = 全部在线设备
    @State private var sending = false
    @State private var showKnown = true

    var body: some View {
        NavigationStack {
            List {
                Section { statusRow } header: { Text("服务状态") }
                Section { controlPanel } header: { Text("播报 / 唤醒") }
                Section { knownSection } header: {
                    HStack {
                        Text("设备 · \(vm.knownDevices.count)（在线 \(vm.onlineCount)）")
                        Spacer()
                        Button(showKnown ? "收起" : "展开") { showKnown.toggle() }
                            .font(.caption)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("小智设备")
            .navigationDestination(for: XZKnownDevice.self) { d in
                DeviceDetailView(device: d)
            }
            .refreshable { await vm.refresh() }
            .overlay { if !vm.isLoaded { ProgressView("连接中…") } }
        }
    }

    // MARK: - 子视图

    @ViewBuilder private var statusRow: some View {
        if vm.isConnected, let h = vm.health {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.seal.fill").foregroundStyle(.green)
                    Text("服务在线").fontWeight(.semibold)
                    Spacer()
                    Text("在线 \(h.devices ?? vm.onlineCount)").foregroundStyle(.secondary)
                }
                Text("通道 \(h.channel ?? "-") · 运行 \(xzUptime(h.uptime))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } else {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                Text(vm.errorMessage ?? "服务不可达，请到设置页检查地址")
                    .font(.callout)
            }
        }
    }

    @ViewBuilder private var controlPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextEditor(text: $text)
                .frame(minHeight: 72)
                .font(.body)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("要播报给小智的文字…")
                            .foregroundStyle(.tertiary)
                            .padding(.top, 8).padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }

            Picker("目标设备", selection: $targetId) {
                Text("全部在线设备").tag("")
                ForEach(vm.knownDevices) { d in
                    Text("\(d.displayName)（\(d.isOnline ? "在线" : d.isResting ? "休息" : "离线")）")
                        .tag(d.keyId)
                }
            }
            .pickerStyle(.menu)

            HStack(spacing: 12) {
                Button {
                    Task {
                        sending = true
                        await vm.broadcast(text: text, deviceId: targetId.isEmpty ? nil : targetId)
                        sending = false
                    }
                } label: {
                    Label(sending ? "发送中…" : "播报", systemImage: "speaker.wave.2.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(sending || text.trimmed.isEmpty)

                Button {
                    Task {
                        sending = true
                        await vm.wake(deviceId: targetId.isEmpty ? nil : targetId)
                        sending = false
                    }
                } label: {
                    Label("唤醒", systemImage: "bell.zzz")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(sending)
            }

            if let msg = vm.actionMessage {
                Text(msg).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder private var knownSection: some View {
        if showKnown {
            if vm.knownDevices.isEmpty {
                Text("暂无登记设备").font(.callout).foregroundStyle(.secondary)
            } else {
                ForEach(vm.knownDevices) { d in
                    NavigationLink(value: d) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(d.displayName).fontWeight(.medium)
                                HStack(spacing: 6) {
                                    if let m = d.model, !m.isEmpty {
                                        Text(m).font(.caption2).foregroundStyle(.secondary)
                                    }
                                    // 能力徽章：机器人硬件 / 智能家居（支持才显示）
                                    if d.isRobot {
                                        Image(systemName: "cpu")
                                            .font(.caption2).foregroundStyle(.blue)
                                            .accessibilityLabel("支持机器人硬件")
                                    }
                                    if d.isHome {
                                        Image(systemName: "house.fill")
                                            .font(.caption2).foregroundStyle(.green)
                                            .accessibilityLabel("支持智能家居")
                                    }
                                }
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 4) {
                                StatusBadge(kind: d.isOnline ? .online : (d.isResting ? .resting : .offline))
                                Text(xzRelativeTime(d.last_seen)).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                }
            }
        }
    }
}

/// uptime（秒）转"x 小时 y 分"
private func xzUptime(_ seconds: Double?) -> String {
    guard let s = seconds else { return "-" }
    let total = Int(s)
    let h = total / 3600, m = (total % 3600) / 60
    if h > 0 { return "\(h) 小时 \(m) 分" }
    return "\(m) 分"
}
