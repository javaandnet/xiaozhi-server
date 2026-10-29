import SwiftUI
import UIKit

/// 进入遥控页锁定横屏，离开恢复竖屏（Info.plist 已同时声明两个方向）。
enum OrientationLock {
    static func apply(_ mask: UIInterfaceOrientationMask) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        guard let scene else { return }
        // 先让根 VC 重新评估支持方向，再请求几何更新（iOS 16+ 强制转屏）
        scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask))
    }
}

/// 横屏遥控操作页（功能与 Web 端 RobotGamepad 对齐）：
/// 左柄＝底盘方向（动作授权默认开＝免确认）+ 发送语音（文字播报）+ 识人/找人；
/// 中列＝摄像头实时预览（三档模式/启停）；
/// 右柄＝头部云台 + 机械臂末端微调（共享一个动作授权开关，默认开＝免确认）+ 连续动作（大动作始终逐次确认）。
/// 开关语义：开＝已授权直接执行；关＝每次动作都弹确认。
/// 底盘仍受服务端 robot.allowChassis 红线锁定（遥控页内点状态标签解锁/加锁）；急停永远免确认。
struct RobotConsoleView: View {
    @ObservedObject var vm: RobotViewModel
    @StateObject private var faceVM: FaceViewModel

    @State private var driveAllowed = true        // 左柄动作授权（默认开＝免确认直接执行）
    @State private var motionAllowed = true       // 右柄（云台+微调）共享动作授权（默认开＝免确认直接执行）
    @State private var poseAllowed = false        // 连续动作（大动作）授权（默认关＝每次确认；开＝免确认）
    @State private var pendingAction: (() -> Void)?
    @State private var confirmTitle = ""
    @State private var showConfirm = false
    @State private var findName = ""
    @State private var speakText = ""
    @State private var speakLine: String?
    @State private var showShutdown1 = false
    @State private var showShutdown2 = false
    @State private var showChassisUnlock = false   // 轮动解锁二重确认（安全红线）
    @State private var showSpeakSheet = false      // 发送语音弹层（操作空间小，改为按钮弹出较大画面）
    @State private var showFaceSheet = false       // 人脸识别弹层
    @State private var shutdownLine: String?
    @State private var reconnectLine: String?      // 重连身体结果（与 Web 端同功能）
    @State private var driveLine: String?
    @State private var motionLine: String?
    @State private var faceLine: String?

    private let padCols = Array(repeating: GridItem(.flexible(), spacing: 6), count: 3)

    init(vm: RobotViewModel) {
        self.vm = vm
        _faceVM = StateObject(wrappedValue: FaceViewModel(device: vm.selectedKey))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            leftColumn.frame(maxWidth: .infinity)
            centerColumn.frame(maxWidth: .infinity)
            rightColumn.frame(maxWidth: .infinity)
        }
        .padding(8)
        .background(Color(.systemGroupedBackground))
        .navigationTitle("遥控 · \(vm.selectedRobot?.displayName ?? "-")")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showShutdown1 = true
                } label: {
                    Label("关机", systemImage: vm.shuttingDown ? "hourglass" : "power")
                }
                .disabled(vm.selectedKey.isEmpty || vm.shuttingDown)
            }
            // 重连身体：server 重启后派侧僵尸 TCP 假在线（相机正常但云台无法连接）时一键自愈，与 Web 遥控页同功能
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { reconnectLine = await vm.reconnectBody() }
                } label: {
                    Label("重连身体", systemImage: "cable.connector")
                }
                .disabled(vm.isBusy)
            }
        }
        .onAppear {
            // 转屏请求需在 push 转场完成后才生效，补发两次兼顾动画尾帧
            for delay in [0.15, 0.6] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    OrientationLock.apply([.landscapeLeft, .landscapeRight])
                }
            }
        }
        .onDisappear { OrientationLock.apply(.portrait) }
        .alert(confirmTitle, isPresented: $showConfirm) {
            Button("执行") { pendingAction?(); pendingAction = nil }
            Button("取消", role: .cancel) { pendingAction = nil }
        } message: {
            Text("授权开关打开时直接执行；关掉后每次动作都需确认。")
        }
        // 关机二重确认：第一道告知后果，第二道最终拦截误触
        .alert("关机机器人？", isPresented: $showShutdown1) {
            Button("继续", role: .destructive) { showShutdown2 = true }
            Button("取消", role: .cancel) {}
        } message: {
            Text("系统将安全停止后断电，需按设备上物理电源键才能重新开机。建议先停止预览与移动动作。")
        }
        .alert("最终确认关机", isPresented: $showShutdown2) {
            Button("确认关机", role: .destructive) {
                Task { shutdownLine = await vm.shutdown() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("电池供电时：关机后请再关闭扩展板开关，否则待机电流会持续放干电池致过放无法开机。")
        }
        // 轮动解锁安全确认：机器常放桌上，移动有坠落风险（加锁方向无需确认）
        .alert("解锁轮动？", isPresented: $showChassisUnlock) {
            Button("解锁", role: .destructive) {
                Task { await vm.setChassis(true) }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("轮子受安全红线锁定。解锁前请确认机器人已放到地面：机器若放桌上，移动有坠落风险。")
        }
        .task {
            await vm.loadSafety()
            await faceVM.detectRole()
            await faceVM.refreshStream()
            // 进页自动拉起预览（与 Web autoOpenPreview 同口径）
            if !faceVM.streamRunning && !vm.selectedKey.isEmpty { await faceVM.startStream() }
        }
        // 发送语音：按钮弹出较大画面处理
        .sheet(isPresented: $showSpeakSheet) { speakSheet }
        // 人脸识别：按钮弹出较大画面处理
        .sheet(isPresented: $showFaceSheet) { faceSheet }
    }

    // MARK: - 发送语音弹层

    private var speakSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Text("要小智朗读的文字 / 自然语言命令：").font(.subheadline.bold())
                TextEditor(text: $speakText)
                    .frame(minHeight: 120)
                    .padding(6)
                    .background(Color(.secondarySystemGroupedBackground),
                                in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
                if let speakLine { statusText(speakLine).font(.callout) }
                Button {
                    Task {
                        speakLine = await vm.speak(text: speakText)
                        if speakLine?.hasPrefix("✓") == true { speakText = "" }
                    }
                } label: {
                    Label(vm.isBusy ? "发送中…" : "🔊 播报", systemImage: "speaker.wave.2.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .disabled(vm.isBusy || speakText.trimmed.isEmpty)
                Spacer()
            }
            .padding()
            .navigationTitle("发送语音给小智")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { showSpeakSheet = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - 人脸识别弹层

    private var faceSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Button {
                    Task {
                        await faceVM.ensureFaceMode()
                        faceLine = await vm.faceRecognize()
                    }
                } label: {
                    Label("🧑 识人（只看当前画面认是谁，不运动）", systemImage: "person.crop.circle.badge.checkmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.large)
                .disabled(vm.isBusy || vm.selectedKey.isEmpty)

                Text("找人（巡视寻脸→对准→识人，只动头/躯干不碰轮子）：").font(.subheadline.bold())
                HStack(spacing: 8) {
                    TextField("找谁（空=任何人）", text: $findName)
                        .textFieldStyle(.roundedBorder)
                    Button {
                        Task {
                            await faceVM.ensureFaceMode()
                            faceLine = await vm.searchFace(name: findName)
                        }
                    } label: {
                        Label(vm.isBusy ? "查找中…" : "🔍 找", systemImage: "person.fill.viewfinder")
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .disabled(vm.isBusy || vm.selectedKey.isEmpty)
                }
                if let faceLine { statusText(faceLine).font(.callout) }
                Spacer()
            }
            .padding()
            .navigationTitle("人脸识别")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { showFaceSheet = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    /// 动作授权门：开关开＝直接执行；关＝每次动作两步确认（云台/微调默认开，连续动作默认关）。
    private func guarded(_ group: String, _ label: String, _ run: @escaping () -> Void) {
        let allowed: Bool
        switch group {
        case "drive": allowed = driveAllowed
        case "pose":  allowed = poseAllowed
        default:      allowed = motionAllowed
        }
        if allowed {
            run()
        } else {
            confirmTitle = "确认执行：\(label)？"
            pendingAction = run
            showConfirm = true
        }
    }

    // MARK: - 左柄：底盘 + 语音信息 + 人脸识别

    private var leftColumn: some View {
        ScrollView {
            VStack(spacing: 8) {
                HStack {
                    Text("底盘").font(.subheadline.bold())
                    // 点状态标签切换解锁/加锁：解锁需确认（防桌上误动），加锁直接生效
                    Button {
                        if vm.chassisAllowed {
                            Task { await vm.setChassis(false) }
                        } else {
                            showChassisUnlock = true
                        }
                    } label: {
                        Text(vm.chassisAllowed ? "🔓 轮动已解锁(点按加锁)" : "🔒 轮动锁定(点按解锁)")
                            .font(.caption2)
                            .foregroundStyle(vm.chassisAllowed ? .orange : .green)
                    }
                    Spacer()
                    Toggle("动作授权", isOn: $driveAllowed)
                        .font(.caption2).toggleStyle(.switch).controlSize(.mini)
                }
                LazyVGrid(columns: padCols, spacing: 6) {
                    padButton("⟲", "原地左转") { guarded("drive", "原地左转") { Task { driveLine = await vm.drive("turn_left") } } }
                    padButton("▲", "前进") { guarded("drive", "前进") { Task { driveLine = await vm.drive("forward") } } }
                    padButton("⟳", "原地右转") { guarded("drive", "原地右转") { Task { driveLine = await vm.drive("turn_right") } } }
                    padButton("◀", "左移") { guarded("drive", "左移") { Task { driveLine = await vm.drive("left") } } }
                    padButton("⏹", "急停", tint: .red) { Task { driveLine = await vm.drive("stop") } }
                    padButton("▶", "右移") { guarded("drive", "右移") { Task { driveLine = await vm.drive("right") } } }
                    Color.clear.frame(height: 1)
                    padButton("▼", "后退") { guarded("drive", "后退") { Task { driveLine = await vm.drive("backward") } } }
                    Color.clear.frame(height: 1)
                }
                if let driveLine { statusText(driveLine) }

                Divider()

                // 发送语音 / 人脸识别：操作空间小，改为按钮，点击弹出较大画面处理
                HStack(spacing: 10) {
                    Button {
                        showSpeakSheet = true
                    } label: {
                        Label("发送语音", systemImage: "speaker.wave.2.fill")
                            .font(.caption)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(.bordered)

                    Button {
                        showFaceSheet = true
                    } label: {
                        Label("人脸识别", systemImage: "person.crop.circle.badge.checkmark")
                            .font(.caption)
                            .frame(maxWidth: .infinity, minHeight: 40)
                    }
                    .buttonStyle(.bordered)
                }
                .disabled(vm.selectedKey.isEmpty)
                if let speakLine { statusText(speakLine) }
                if let shutdownLine { statusText(shutdownLine) }
                if let reconnectLine { statusText(reconnectLine) }
            }
            .padding(8)
            .background(card)
        }
    }

    // MARK: - 中列：摄像头预览

    private var centerColumn: some View {
        VStack(spacing: 8) {
            CameraPreview(url: faceVM.streamURL, headers: faceVM.streamHeaders)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay {
                    if !faceVM.streamRunning {
                        Text("摄像头预览未启动").font(.caption).foregroundStyle(.gray)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Picker("模式", selection: Binding(
                get: { faceVM.mode },
                set: { m in Task { await faceVM.setMode(m) } }
            )) {
                ForEach(FaceViewModel.modeOptions, id: \.value) { opt in
                    Text(opt.label).tag(opt.value)
                }
            }
            .pickerStyle(.segmented)
            .disabled(faceVM.isBusy)
            HStack(spacing: 8) {
                Text(faceVM.streamRunning ? "● 运行中" : "○ 未运行")
                    .font(.caption).foregroundStyle(faceVM.streamRunning ? .green : .secondary)
                if let e = faceVM.lastError {
                    Text(e).font(.caption2).foregroundStyle(.red).lineLimit(1)
                }
                Spacer()
                Button(faceVM.streamRunning ? "停止" : "启动") {
                    Task {
                        if faceVM.streamRunning { await faceVM.stopStream() }
                        else { await faceVM.startStream() }
                    }
                }
                .buttonStyle(.bordered)
                .disabled(faceVM.isBusy)
            }
        }
        .padding(8)
        .background(card)
    }

    // MARK: - 右柄：云台 + 微调（共享动作确认，默认开）

    private var rightColumn: some View {
        ScrollView {
            VStack(spacing: 8) {
                HStack {
                    Text("云台 · 微调").font(.subheadline.bold())
                    Spacer()
                    Toggle("动作授权", isOn: $motionAllowed)
                        .font(.caption2).toggleStyle(.switch).controlSize(.mini)
                }
                LazyVGrid(columns: padCols, spacing: 6) {
                    padButton("⤒", "抬头") { guarded("motion", "云台·抬头") { Task { motionLine = await vm.pan("up") } } }
                    Color.clear.frame(height: 1)
                    padButton("⤓", "低头") { guarded("motion", "云台·低头") { Task { motionLine = await vm.pan("down") } } }
                    padButton("⤜", "左转") { guarded("motion", "云台·左转") { Task { motionLine = await vm.pan("left") } } }
                    padButton("◎", "回正") { guarded("motion", "云台·回正") { Task { motionLine = await vm.pan("center") } } }
                    padButton("⤘", "右转") { guarded("motion", "云台·右转") { Task { motionLine = await vm.pan("right") } } }
                }
                Text("手臂微调 (\(Self.fmt(vm.ikPose.x)), \(Self.fmt(vm.ikPose.y)), \(Self.fmt(vm.ikPose.z)))cm")
                    .font(.caption2).foregroundStyle(.secondary)
                // 相反动作同列上下配对：升/降、前伸/回收、左/右（基准与符号由 server 统一）
                LazyVGrid(columns: padCols, spacing: 6) {
                    padButton("⬆️", "升高") { guarded("motion", "微调·升高") { Task { motionLine = await vm.ikJog("up") } } }
                    padButton("↗️", "前伸") { guarded("motion", "微调·前伸") { Task { motionLine = await vm.ikJog("forward") } } }
                    padButton("⬅️", "左移") { guarded("motion", "微调·左移") { Task { motionLine = await vm.ikJog("left") } } }
                    padButton("⬇️", "降低") { guarded("motion", "微调·降低") { Task { motionLine = await vm.ikJog("down") } } }
                    padButton("↙️", "回收") { guarded("motion", "微调·回收") { Task { motionLine = await vm.ikJog("back") } } }
                    padButton("➡️", "右移") { guarded("motion", "微调·右移") { Task { motionLine = await vm.ikJog("right") } } }
                    padButton("⌂", "回位") { guarded("motion", "微调·回位") { Task { motionLine = await vm.ikJog("home") } } }
                }
                if let motionLine { statusText(motionLine) }

                Divider()

                HStack {
                    Text("连续动作").font(.subheadline.bold())
                    Spacer()
                    Toggle("动作授权", isOn: $poseAllowed)
                        .font(.caption2).toggleStyle(.switch).controlSize(.mini)
                }
                LazyVGrid(columns: padCols, spacing: 6) {
                    ForEach(RobotConsoleView.arms, id: \.pose) { a in
                        padButton(a.icon, a.label) { guarded("pose", "机械臂·\(a.label)") { Task { motionLine = await vm.arm(a.pose) } } }
                    }
                }
            }
            .padding(8)
            .background(card)
        }
    }

    static let arms: [(pose: String, icon: String, label: String)] = [
        ("greet", "🙌", "张开手臂"), ("wave", "👋", "挥手"), ("nod", "🐦", "点头"),
        ("shake", "🚫", "摇头"), ("raise_right", "✋", "举手"), ("bow", "🙇", "鞠躬"),
        ("dance", "💃", "跳舞"), ("reset", "⤐", "手臂归位"),
    ]

    /// Double 紧凑显示（0 而非 0.000000）
    private static func fmt(_ v: Double) -> String {
        String(format: "%g", v)
    }

    // MARK: - 小件

    private func padButton(_ icon: String, _ label: String, tint: Color = .primary,
                           _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 1) {
                Text(icon).font(.subheadline)
                Text(label).font(.caption2)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(tint == .red ? Color.red.opacity(0.12) : Color(.secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
        .disabled(vm.isBusy || vm.selectedKey.isEmpty)
    }

    private func statusText(_ s: String) -> some View {
        Text(s).font(.caption2)
            .foregroundStyle(s.hasPrefix("✗") ? .red : .secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }

    private var card: some View {
        RoundedRectangle(cornerRadius: 14).fill(Color(.secondarySystemGroupedBackground).opacity(0.5))
    }
}
