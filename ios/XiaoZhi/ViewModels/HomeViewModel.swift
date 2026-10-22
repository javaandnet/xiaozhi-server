import Foundation
import SwiftUI

/// 家庭设备（HomeKit 方案A）状态：可控灯具、直控开关/亮度/色温、局域网扫描与配对、设定读写。
@MainActor
final class HomeViewModel: ObservableObject {
    @Published var status: XZHomeStatus?
    @Published var settings: XZHomeSettings = .init()
    @Published var scanned: [XZHomeScanDevice] = []
    @Published var controlMessage: String?
    @Published var isBusy = false
    @Published var isLoaded = false
    @Published var errorMessage: String?

    var lights: [XZHomeLight] { status?.lights ?? [] }
    var isEnabled: Bool { status?.enabled == true || settings.enabled == true }

    func refresh() async {
        do {
            let st = try await APIClient.shared.get(XZHomeStatus.self, Endpoint.homekitStatus)
            status = st
            if let env = try? await APIClient.shared.get(XZHomeSettingsEnvelope.self, Endpoint.homekitSettings) {
                settings = env.settings ?? settings
            }
            errorMessage = nil
        } catch let e as APIError {
            if !e.isCancelled { errorMessage = e.errorDescription }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoaded = true
    }

    /// 直控：power/brightness/colorTemp 任意子集下发，回读据实文案
    func control(lightKey: String, power: Bool? = nil, brightness: Int? = nil, colorTemp: Int? = nil) async {
        isBusy = true; controlMessage = nil
        defer { isBusy = false }
        var json: [String: Any] = ["light": lightKey]
        if let power { json["power"] = power }
        if let brightness { json["brightness"] = brightness }
        if let colorTemp { json["color_temp"] = colorTemp }
        do {
            let ack = try await APIClient.shared.postJSON(XZHomeControlAck.self, Endpoint.homekitControl, json: json)
            controlMessage = (ack.ok == true) ? (ack.result ?? "指令已下发") : "✗ \(ack.error ?? "控制失败")"
        } catch let e as APIError {
            controlMessage = "✗ \(e.errorDescription ?? "请求失败")"
        } catch {
            controlMessage = "✗ \(error.localizedDescription)"
        }
    }

    /// 灯具重命名：后端热更新内存映射 + 持久化 config.json（改名后语音播报/工具描述同步），成功后刷新列表
    func rename(lightKey: String, name: String) async {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !lightKey.isEmpty, !n.isEmpty else {
            controlMessage = "✗ 名称不能为空"; return
        }
        isBusy = true; controlMessage = nil
        defer { isBusy = false }
        do {
            let ack = try await APIClient.shared.postJSON(XZHomeRenameAck.self, Endpoint.homekitRename,
                                                          json: ["light": lightKey, "name": n])
            if ack.ok == true {
                controlMessage = "✓ 已重命名为「\(ack.name ?? n)」" + (ack.persisted == true ? "（已持久化）" : "")
                await refresh()
            } else {
                controlMessage = "✗ \(ack.error ?? "重命名失败")"
            }
        } catch let e as APIError {
            controlMessage = "✗ \(e.errorDescription ?? "请求失败")"
        } catch {
            controlMessage = "✗ \(error.localizedDescription)"
        }
    }

    func scan() async {
        isBusy = true; scanned = []
        defer { isBusy = false }
        do {
            let r = try await APIClient.shared.postJSON(XZHomeScanResult.self, Endpoint.homekitScan, json: [:])
            scanned = r.devices ?? []
            if r.ok != true { errorMessage = r.error }
        } catch let e as APIError {
            errorMessage = e.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func pair(pin: String, deviceName: String) async {
        isBusy = true; controlMessage = nil
        defer { isBusy = false }
        var json: [String: Any] = [:]
        if !pin.isEmpty { json["pin"] = pin }
        if !deviceName.isEmpty { json["deviceName"] = deviceName }
        do {
            let st = try await APIClient.shared.postJSON(XZHomeStatus.self, Endpoint.homekitPair, json: json)
            if st.ok == true {
                status = st
                controlMessage = "✓ 配对完成，可控灯具 \(st.lights?.count ?? 0) 个"
            } else {
                controlMessage = "✗ \(st.error ?? "配对失败")"
            }
        } catch let e as APIError {
            controlMessage = "✗ \(e.errorDescription ?? "请求失败")"
        } catch {
            controlMessage = "✗ \(error.localizedDescription)"
        }
    }

    func saveSettings() async {
        isBusy = true; controlMessage = nil
        defer { isBusy = false }
        do {
            let ack = try await APIClient.shared.postJSON(XZHomeSettingsEnvelope.self, Endpoint.homekitSettings,
                                                          json: [
                                                            "enabled": settings.enabled ?? false,
                                                            "deviceName": settings.deviceName ?? "",
                                                            "discoveryTimeoutMs": settings.discoveryTimeoutMs ?? 15000
                                                          ])
            if ack.ok == true {
                settings = ack.settings ?? settings
                controlMessage = "✓ 设定已保存"
                await refresh()
            } else {
                controlMessage = "✗ \(ack.error ?? "保存失败")"
            }
        } catch let e as APIError {
            controlMessage = "✗ \(e.errorDescription ?? "请求失败")"
        } catch {
            controlMessage = "✗ \(error.localizedDescription)"
        }
    }
}
