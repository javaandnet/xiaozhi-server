import SwiftUI

/// 对话记录：可按设备过滤，展示服务端最近转写（user 问 / bot 答），支持下拉刷新。
struct ConversationListView: View {
    @ObservedObject var vm: ConversationsViewModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("设备", selection: Binding(
                        get: { vm.selectedDeviceId },
                        set: { id in Task { await vm.selectDevice(id) } }
                    )) {
                        Text("全部设备").tag("")
                        ForEach(vm.devices) { d in
                            Text("\(d.displayName)（\(d.keyId)）").tag(d.keyId)
                        }
                    }
                    .pickerStyle(.menu)
                } header: {
                    Text("按设备过滤")
                }
                if let err = vm.errorMessage {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red).font(.callout)
                    }
                }
                Section {
                    if vm.conversations.isEmpty {
                        Text(vm.isLoaded ? "暂无对话记录" : "加载中…")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(vm.conversations) { item in row(item) }
                    }
                } header: {
                    Text("最近对话 · 共 \(vm.total) 条")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("对话记录")
            .refreshable { await vm.refresh() }
            .task {
                await vm.loadDevicesIfNeeded()
                if !vm.isLoaded { await vm.refresh() }
            }
        }
    }

    @ViewBuilder private func row(_ item: XZConversation) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: item.isUser ? "person.crop.circle" : "hifireceiver")
                    .foregroundStyle(item.isUser ? .blue : .green)
                Text(item.isUser ? "用户" : "小智").font(.caption).fontWeight(.semibold)
                if let e = item.emotion, !e.isEmpty {
                    Text("[\(e)]").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if let date = item.date {
                    Text(date, style: .time).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Text(item.text ?? "").font(.body)
            if let dev = item.device_id, !dev.isEmpty {
                Text(dev).font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}
