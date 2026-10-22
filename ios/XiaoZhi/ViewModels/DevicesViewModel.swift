import Foundation
import SwiftUI

// MARK: - 请求体

struct BroadcastPayload: Encodable {
    let text: String
    let deviceId: String?
}

struct WakePayload: Encodable {
    let deviceId: String?
    let announce: String?
}

struct SpeakPayload: Encodable {
    let deviceId: String?
    let text: String
}

/// 设备面板状态：拉取健康 + 实时在线设备 + 已登记设备，并下发播报/唤醒指令。
/// 服务端无事件流，靠下拉刷新 / 定时轮询感知在线变化（10s）。
@MainActor
final class DevicesViewModel: ObservableObject {
    @Published var health: XZHealth?
    @Published var knownDevices: [XZKnownDevice] = []
    @Published var isLoaded = false
    @Published var errorMessage: String?
    @Published var actionMessage: String?

    private var pollTask: Task<Void, Never>?

    var isConnected: Bool { health?.isOK == true }
    /// 在线数：已登记列表按实时 WS 标注的 online 列统计（/api/devices/known 已合并实时连接态）
    var onlineCount: Int { knownDevices.filter { $0.isOnline }.count }

    func start() {
        stop()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        do {
            health = try await APIClient.shared.get(XZHealth.self, Endpoint.health)
            let page = try await APIClient.shared.get(XZDevicePage.self, Endpoint.knownDevices,
                                                       query: ["limit": "100"])
            knownDevices = page.items ?? []
            errorMessage = nil
        } catch let e as APIError {
            if e.isCancelled { return }
            health = nil
            errorMessage = e.errorDescription
        } catch {
            health = nil
            errorMessage = error.localizedDescription
        }
        isLoaded = true
    }

    /// 文本播报：有 voiceKey 走 /api/voice/speak，否则回落免鉴权 /api/broadcast
    func broadcast(text: String, deviceId: String?) async {
        actionMessage = nil
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { actionMessage = "播报内容不能为空"; return }
        do {
            if ClientSettings.voiceKey.isEmpty {
                let ack = try await APIClient.shared.post(XZBroadcastAck.self, Endpoint.broadcast,
                                                          body: BroadcastPayload(text: trimmed, deviceId: deviceId))
                actionMessage = (ack.success == true)
                    ? "已排队播报 → \(ack.devices ?? 0) 台设备"
                    : "播报失败：\(ack.error ?? "未知错误")"
            } else {
                let ack = try await APIClient.shared.post(XZVoiceSpeakAck.self, Endpoint.voiceSpeak,
                                                          body: SpeakPayload(deviceId: deviceId, text: trimmed))
                actionMessage = (ack.ok == true)
                    ? "已排队播报 → \(ack.devices ?? 0) 台设备"
                    : "播报失败：\(ack.error ?? "未知错误")"
            }
        } catch let e as APIError {
            actionMessage = e.errorDescription
        } catch {
            actionMessage = error.localizedDescription
        }
    }

    /// 远程唤醒（退出休息模式 + 下发 wake）
    func wake(deviceId: String?) async {
        actionMessage = nil
        do {
            let ack = try await APIClient.shared.post(XZWakeAck.self, Endpoint.wake,
                                                      body: WakePayload(deviceId: deviceId, announce: nil))
            actionMessage = (ack.success == true)
                ? "已唤醒 → \(ack.devices ?? 0) 台设备"
                : "唤醒失败：\(ack.error ?? "未知错误")"
        } catch let e as APIError {
            actionMessage = e.errorDescription
        } catch {
            actionMessage = error.localizedDescription
        }
    }
}

/// 对话记录状态：可按设备过滤，分页拉取最近转写文本。
@MainActor
final class ConversationsViewModel: ObservableObject {
    @Published var conversations: [XZConversation] = []
    @Published var devices: [XZKnownDevice] = []
    @Published var selectedDeviceId: String = ""   // "" = 全部设备
    @Published var total = 0
    @Published var isLoaded = false
    @Published var errorMessage: String?

    /// 拉取设备列表（供过滤下拉）；仅在未加载时拉一次
    func loadDevicesIfNeeded() async {
        guard devices.isEmpty else { return }
        let page = try? await APIClient.shared.get(XZDevicePage.self, Endpoint.knownDevices,
                                                   query: ["limit": "100"])
        devices = page?.items ?? []
    }

    /// 切换过滤设备并重新拉取
    func selectDevice(_ id: String) async {
        selectedDeviceId = id
        await refresh()
    }

    func refresh() async {
        do {
            var query = ["limit": "50"]
            if !selectedDeviceId.isEmpty { query["deviceId"] = selectedDeviceId }
            let page = try await APIClient.shared.get(XZConversationPage.self, Endpoint.conversations,
                                                      query: query)
            conversations = page.items ?? []
            total = page.total ?? conversations.count
            errorMessage = nil
        } catch let e as APIError {
            if !e.isCancelled { errorMessage = e.errorDescription }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoaded = true
    }
}
