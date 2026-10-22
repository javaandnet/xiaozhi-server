import SwiftUI

/// MasterPi 人脸登记页（从机器人页进入）：摄像头预览 + 云台微调 + 诱导式登记/追加 + 人脸库 + 登录。
/// 诱导式流程：① 启动预览并对齐云台 → ② 填称呼开始采集（多帧引导）→ ③ 成功入库；已登记成员可"追加样本"。
struct FaceEnrollView: View {
    @StateObject var vm: FaceViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var appendTarget: XZFacePerson? = nil
    @State private var step: Int = 1                 // 1 对齐 / 2 采集中 / 3 完成
    @State private var result: String? = nil
    @State private var alignMsg: String? = nil

    var body: some View {
        NavigationStack {
            List {
                previewSection
                alignSection
                wizardSection
                facesSection
                loginSection
            }
            .listStyle(.insetGrouped)
            .navigationTitle("人脸登记")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } }
            }
            .overlay { if vm.isBusy && step == 2 { ProgressView("采集中…").scaleEffect(1.3) } }
            .task {
                await vm.loadFaces()
                await vm.refreshStream()
                if name.isEmpty { name = vm.defaultName() }
                if !vm.streamRunning { await vm.startStream() }   // 进入即拉起预览，边看边对齐
            }
            .onDisappear { Task { await vm.stopStream() } }       // 离开释放相机
        }
    }

    // MARK: - 预览

    private var previewSection: some View {
        Section {
            CameraPreview(url: vm.streamURL)
                .frame(height: 220)
                .listRowInsets(EdgeInsets())
                .clipped()
            HStack {
                Label(vm.streamRunning ? "预览进行中" : "预览未启动",
                      systemImage: vm.streamRunning ? "video.fill" : "video.slash.fill")
                    .font(.caption)
                    .foregroundStyle(vm.streamRunning ? .green : .secondary)
                Spacer()
                Button(vm.streamRunning ? "停止预览" : "启动预览") {
                    Task {
                        if vm.streamRunning { await vm.stopStream() } else { await vm.startStream() }
                    }
                }
                .font(.caption)
                .disabled(!vm.hasBody)
            }
        } header: { Text("① 摄像头预览 · 正对被登记者的脸") }
    }

    // MARK: - 云台微调

    private var alignSection: some View {
        Section {
            HStack(spacing: 12) {
                alignButton("up", "arrow.up")
                alignButton("down", "arrow.down")
                alignButton("left", "arrow.left")
                alignButton("right", "arrow.right")
                alignButton("center", "dot.circle")
            }
            .frame(maxWidth: .infinity)
            if let m = alignMsg {
                Text(m).font(.caption)
                    .foregroundStyle(m.hasPrefix("✗") ? .red : .secondary)
            }
        } header: { Text("云台微调（俯仰 / 水平 / 回正）") }
        footer: { Text("边看实时画面边点按，把镜头正对脸部后再采集。").font(.footnote) }
    }

    private func alignButton(_ action: String, _ icon: String) -> some View {
        Button {
            Task { alignMsg = await vm.align(action) }
        } label: {
            Image(systemName: icon).frame(width: 34, height: 34)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(!vm.hasBody || vm.isBusy)
    }

    // MARK: - 诱导式登记 / 追加

    private var wizardSection: some View {
        Section {
            if let t = appendTarget {
                HStack {
                    Label("为「\(t.displayName)」追加样本", systemImage: "plus.person")
                        .font(.callout).foregroundStyle(.blue)
                    Spacer()
                    Button("取消") { appendTarget = nil; name = vm.defaultName(); result = nil; step = 1 }
                        .font(.caption)
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("称呼").font(.caption).foregroundStyle(.secondary)
                    TextField("被登记者的称呼", text: $name)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }

            Button {
                startCapture()
            } label: {
                HStack {
                    Text(step == 2 ? "采集中…" : (appendTarget == nil ? "开始采集（诱导式登记）" : "开始追加采集"))
                    Spacer()
                    Image(systemName: "person.badge.plus")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(vm.isBusy || !vm.hasBody || (appendTarget == nil && name.trimmed.isEmpty))

            if let result {
                Text(result).font(.callout)
                    .foregroundStyle(result.hasPrefix("✗") ? .red : .primary)
                    .textSelection(.enabled)
            }
        } header: {
            Text("② 采集入库 · \(vm.hasBody ? "身体 \(vm.device)" : "未选身体")")
        } footer: {
            Text("采集时机器人会引导正脸/左右侧脸多角度；未检到脸会提示重试。")
                .font(.footnote)
        }
    }

    private func startCapture() {
        step = 2; result = nil
        Task {
            let targetId = appendTarget?.id
            let displayName = appendTarget?.name ?? name
            let (ok, msg) = await vm.enroll(name: displayName, appendToId: targetId)
            result = msg
            step = ok ? 3 : 1
            if ok && appendTarget == nil {
                name = vm.defaultName()   // 新登记成功后预填下一个默认称呼
            }
        }
    }

    // MARK: - 人脸库

    private var facesSection: some View {
        Section {
            if vm.faces.isEmpty {
                Text("人脸库为空").foregroundStyle(.secondary)
            } else {
                ForEach(vm.faces) { p in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.displayName).fontWeight(.medium)
                            Text("ID \(p.id ?? "-") · 样本 \(p.samples ?? 0)")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("追加样本") {
                            appendTarget = p; name = p.displayName ?? ""; result = nil; step = 1
                        }
                        .font(.caption)
                    }
                }
            }
        } header: {
            HStack {
                Text("人脸库 · \(vm.faces.count) 人")
                Spacer()
                Button("刷新") { Task { await vm.loadFaces() } }.font(.caption)
            }
        }
    }

    // MARK: - 人脸登录

    private var loginSection: some View {
        Section {
            HStack {
                Text("当前登录")
                Spacer()
                Text(vm.currentLogin ?? "未登录").foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button("人脸登录") { Task { result = await vm.login() } }
                    .disabled(vm.isBusy || !vm.hasBody)
                Button("退出登录") { Task { result = await vm.logout() } }
                    .disabled(vm.isBusy || !vm.hasBody)
                Spacer()
            }
            .buttonStyle(.bordered)
        } header: {
            Text("人脸登录\(vm.faceLoginEnabled ? "（已开启）" : "（未开启）")")
        } footer: {
            if let e = vm.lastError { Text(e).foregroundStyle(.red).font(.footnote) }
        }
    }
}
