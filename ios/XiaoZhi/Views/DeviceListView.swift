import SwiftUI

/// 设备面板：服务状态 + 已登记设备（顶部按在线状态过滤）。
/// 在线设备方可进入详情页进行设定与播报/命令/唤醒（详情页内集成）。
struct DeviceListView: View {
    @ObservedObject var vm: DevicesViewModel

    /// 顶部过滤器：在线状态
    private enum StatusFilter: String, CaseIterable, Identifiable {
        case all = "全部"
        case online = "在线"
        case resting = "休息"
        case offline = "离线"
        var id: String { rawValue }
    }

    @State private var filter: StatusFilter = .all
    @State private var showKnown = true

    private var filteredDevices: [XZKnownDevice] {
        switch filter {
        case .all: return vm.knownDevices
        case .online: return vm.knownDevices.filter { $0.isOnline }
        case .resting: return vm.knownDevices.filter { $0.isResting && !$0.isOnline }
        case .offline: return vm.knownDevices.filter { !$0.isOnline && !$0.isResting }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section { statusRow } header: { Text("服务状态") }
                Section { filterPicker } header: { Text("过滤") }
                Section { knownSection } header: {
                    HStack {
                        Text("设备 · \(filteredDevices.count)（在线 \(vm.onlineCount)）")
                        Spacer()
                        Button(showKnown ? "收起" : "展开") { showKnown.toggle() }
                            .font(.caption)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("小智设备")
            .navigationDestination(for: XZKnownDevice.self) { d in
                DeviceDetailView(device: d, vm: vm)
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

    @ViewBuilder private var filterPicker: some View {
        Picker("在线状态", selection: $filter) {
            ForEach(StatusFilter.allCases) { f in Text(f.rawValue).tag(f) }
        }
        .pickerStyle(.segmented)
    }

    @ViewBuilder private var knownSection: some View {
        if showKnown {
            if filteredDevices.isEmpty {
                Text(vm.knownDevices.isEmpty ? "暂无登记设备" : "当前过滤条件下无设备")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                ForEach(filteredDevices) { d in
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
