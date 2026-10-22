import SwiftUI

/// 家庭设备页：可控灯具直控（开关/亮度/色温）+ 局域网扫描配对 + HomeKit 设定。
struct HomeView: View {
    @ObservedObject var vm: HomeViewModel
    @State private var pin = ""
    @State private var pairName = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 8) {
                        Image(systemName: vm.isEnabled ? "house.fill" : "house.slash")
                            .foregroundStyle(vm.isEnabled ? .green : .secondary)
                        Text(vm.isEnabled ? "HomeKit 已启用" : "HomeKit 未启用")
                        Spacer()
                        Text("可控 \(vm.lights.count) · 已配对 \(vm.status?.paired?.count ?? 0)")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let msg = vm.controlMessage {
                        Text(msg).font(.footnote)
                            .foregroundStyle(msg.hasPrefix("✗") ? .red : .secondary)
                    }
                } header: {
                    HStack {
                        Text("家庭设备")
                        Spacer()
                        Button("刷新") { Task { await vm.refresh() } }.font(.caption)
                    }
                }
                if let err = vm.errorMessage {
                    Section { Label(err, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.callout) }
                }

                Section {
                    if vm.lights.isEmpty {
                        Text("尚未发现可控灯具，先在下方扫描/配对").foregroundStyle(.secondary)
                    } else {
                        ForEach(vm.lights) { light in
                            LightRow(vm: vm, light: light)
                        }
                    }
                } header: { Text("灯具控制") }

                Section {
                    Button {
                        Task { await vm.scan() }
                    } label: {
                        HStack { Text(vm.isBusy ? "处理中…" : "扫描局域网配件"); Spacer(); if vm.isBusy { ProgressView() } }
                    }
                    .disabled(vm.isBusy)

                    ForEach(vm.scanned) { d in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(d.name ?? d.id).fontWeight(.medium)
                                Spacer()
                                if d.pairedHere == true {
                                    Text("已配对").font(.caption2).foregroundStyle(.green)
                                } else if d.availableForPairing == true {
                                    Text("可配对").font(.caption2).foregroundStyle(.blue)
                                } else {
                                    Text("不可配对").font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            Text("\(d.address ?? ""):\(d.port.map(String.init) ?? "-")")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 1)
                    }

                    HStack {
                        TextField("配对码 pin（如 997-71-230）", text: $pin)
                            .font(.system(.footnote, design: .monospaced))
                            .autocorrectionDisabled()
                        TextField("配件名(可选)", text: $pairName)
                            .font(.system(.footnote, design: .monospaced))
                            .autocorrectionDisabled()
                    }
                    Button("配对选中的可配对设备") {
                        Task { await vm.pair(pin: pin.trimmed, deviceName: pairName.trimmed) }
                    }
                    .disabled(vm.isBusy || pin.trimmed.isEmpty)
                } header: { Text("扫描 / 配对") }
                footer: { Text("扫描不配对，仅列出局域网 HomeKit 配件；配对需配件处于待配对状态并提供 pin。").font(.footnote) }

                Section {
                    Toggle("启用 HomeKit", isOn: Binding(
                        get: { vm.settings.enabled ?? false },
                        set: { vm.settings.enabled = $0 }
                    ))
                    TextField("控制器设备名（可选）", text: Binding(
                        get: { vm.settings.deviceName ?? "" },
                        set: { vm.settings.deviceName = $0 }
                    ))
                    Stepper(value: Binding(
                        get: { Double(vm.settings.discoveryTimeoutMs ?? 15000) },
                        set: { vm.settings.discoveryTimeoutMs = Int($0) }
                    ), in: 5000...60000, step: 5000) {
                        Text("发现超时 \(vm.settings.discoveryTimeoutMs ?? 15000) ms")
                    }
                    Button("保存设定") { Task { await vm.saveSettings() } }
                        .disabled(vm.isBusy)
                } header: { Text("设定") }
                footer: { Text("写入服务端 config.json → homekit（改动会备份原文件）。") }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("家庭设备")
            .refreshable { await vm.refresh() }
            .task { if !vm.isLoaded { await vm.refresh() } }
        }
    }
}

/// 单灯控制行：开关即时下发；亮度/色温滑杆松手时下发；铅笔弹框重命名
private struct LightRow: View {
    @ObservedObject var vm: HomeViewModel
    let light: XZHomeLight
    @State private var power = false
    @State private var brightness = 50.0
    @State private var colorTemp = 50.0
    @State private var showRename = false
    @State private var newName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: power ? "lightbulb.fill" : "lightbulb").foregroundStyle(power ? .yellow : .secondary)
                Text(light.displayName).fontWeight(.medium)
                Button {
                    newName = light.displayName
                    showRename = true
                } label: {
                    Image(systemName: "pencil").font(.caption).foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                Spacer()
                Toggle("", isOn: Binding(
                    get: { power },
                    set: { on in
                        power = on
                        Task { await vm.control(lightKey: light.key ?? "", power: on) }
                    }
                ))
                .labelsHidden()
            }
            if light.hasBrightness == true {
                HStack {
                    Text("亮度").font(.caption).foregroundStyle(.secondary)
                    Slider(value: $brightness, in: 0...100) { editing in
                        if !editing { Task { await vm.control(lightKey: light.key ?? "", brightness: Int(brightness)) } }
                    }
                    Text("\(Int(brightness))").font(.caption2).frame(width: 34, alignment: .trailing)
                }
            }
            if light.hasColorTemp == true {
                HStack {
                    Text("色温").font(.caption).foregroundStyle(.secondary)
                    Slider(value: $colorTemp, in: 0...100) { editing in
                        if !editing { Task { await vm.control(lightKey: light.key ?? "", colorTemp: Int(colorTemp)) } }
                    }
                    Text("\(Int(colorTemp))").font(.caption2).frame(width: 34, alignment: .trailing)
                }
            }
        }
        .padding(.vertical, 2)
        .alert("重命名灯具", isPresented: $showRename) {
            TextField("新的名称", text: $newName)
            Button("保存") {
                Task { await vm.rename(lightKey: light.key ?? "", name: newName) }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("当前：\(light.displayName)。改名后语音叫新名字即可控制，并持久化到服务端。")
        }
    }
}
