import SwiftUI

/// App 根：设备 / 对话 / 设置三个 Tab。设备页为默认落地页。
struct RootView: View {
    @EnvironmentObject private var settings: SettingsStore
    @StateObject private var devicesVM = DevicesViewModel()
    @StateObject private var convVM = ConversationsViewModel()
    @StateObject private var robotVM = RobotViewModel()
    @StateObject private var homeVM = HomeViewModel()

    var body: some View {
        TabView {
            DeviceListView(vm: devicesVM)
                .tabItem { Label("设备", systemImage: "hifireceiver") }

            RobotView(vm: robotVM)
                .tabItem { Label("机器人", systemImage: "cpu") }

            HomeView(vm: homeVM)
                .tabItem { Label("家庭", systemImage: "house") }

            ConversationListView(vm: convVM)
                .tabItem { Label("对话", systemImage: "bubble.left.and.bubble.right") }

            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape2") }
        }
        .task { devicesVM.start() }
        .onChange(of: settings.serverEnv) { _, _ in
            devicesVM.stop()
            Task {
                await devicesVM.refresh(); devicesVM.start()
                await robotVM.refresh()
                await homeVM.refresh()
            }
        }
        .onChange(of: settings.customServer) { _, _ in
            devicesVM.stop()
            Task {
                await devicesVM.refresh(); devicesVM.start()
                await robotVM.refresh()
                await homeVM.refresh()
            }
        }
        .onChange(of: settings.voiceKey) { _, _ in
            Task { await devicesVM.refresh() }
        }
    }
}
