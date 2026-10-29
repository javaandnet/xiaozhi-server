import SwiftUI

/// 设置：接入环境一键切（局域网 / 公网服务器）+ 自定义地址 + 语音流程密钥 + 连通性自检。
/// 地址与档位存 UserDefaults，APIClient 每次请求动态读取 —— 保存即生效，无需重启 App。
struct SettingsView: View {
    @EnvironmentObject private var settings: SettingsStore

    @State private var server: String = ""
    @State private var testing = false
    @State private var healthText: String?
    @State private var healthOK: Bool?

    var body: some View {
        NavigationStack {
            Form {
                // 接入环境：预设「局域网 / 公网」两档一键切
                Section {
                    HStack(spacing: 10) {
                        envChip(.builtin, icon: "house")
                        envChip(.cloud, icon: "cloud")
                    }
                    LabeledContent("当前生效", value: settings.displayBaseURL)
                } header: {
                    Text("接入环境")
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("点一下即切换，无需重启 App。局域网档连 Mac 上的 xiaozhi-server（默认 8003），公网档走 nginx 反代。")
                        if settings.serverEnv == .cloud {
                            Text("提示：公网档须已配好 HTTPS 反代与出口合规；未配好前语音/设备功能可能不可用。")
                                .foregroundStyle(.orange)
                        }
                    }
                    .font(.footnote).foregroundStyle(.secondary)
                }

                // 自定义地址（换 Mac IP、临时指向别的机器）
                Section {
                    TextField("服务器地址", text: $server, prompt: Text("如 192.168.1.55:8003"))
                        .font(.system(.footnote, design: .monospaced))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button("应用自定义地址") {
                        settings.saveCustom(server)
                        healthOK = nil
                        healthText = nil
                    }
                    .disabled(server.trimmed.isEmpty)
                } header: {
                    Text("自定义地址（可选）")
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("只填 host[:port] 或带前缀的完整地址即可，自动补 http://、去尾斜杠；填后自动切到「自定义」档。")
                        Text("内置默认：\(AppConfig.defaultBaseURL.absoluteString)　公网：\(AppConfig.cloudBaseURL.absoluteString)")
                    }
                    .font(.footnote).foregroundStyle(.secondary)
                }

                // 语音流程密钥（/api/voice/* 鉴权）
                Section {
                    SecureField("共享密钥 (sharedToken)", text: $settings.voiceKey)
                        .font(.system(.footnote, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("语音流程密钥（可选）")
                } footer: {
                    Text("填写后播报走鉴权端点 /api/voice/speak；留空则走免鉴权 /api/broadcast。密钥只存本机钥匙串。")
                }

                // 互联密钥（外出读云端相机帧中继鉴权）
                Section {
                    SecureField("互联密钥 (peer.key)", text: $settings.peerKey)
                        .font(.system(.footnote, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("互联密钥（仅外出需要）")
                } footer: {
                    Text("在家（局域网）看预览无需填写；外出连云端时，相机画面经互联帧中继回源家里，需此密钥（与服务 config.peer.key 一致）。只存本机钥匙串。")
                }

                // 连通性自检
                Section("连通性自检") {
                    Button {
                        Task { await test() }
                    } label: {
                        HStack {
                            Text(testing ? "检测中…" : "测试连接")
                            Spacer()
                            if let ok = healthOK {
                                Image(systemName: ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                                    .foregroundStyle(ok ? .green : .red)
                            }
                        }
                    }
                    .disabled(testing)

                    if let healthText {
                        Text(healthText)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }

                Section {
                    Button("恢复默认（局域网档）", role: .destructive) {
                        settings.resetToDefault()
                        server = ""
                        healthOK = nil
                        healthText = nil
                    }
                } footer: {
                    Text("当前版本 \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "-")")
                }
            }
            .navigationTitle("设置")
            .onAppear {
                if server.isEmpty { server = settings.customServer }
            }
        }
    }

    /// 预设档按钮：选中态高亮，点一下直接生效
    private func envChip(_ env: AppConfig.ServerEnv, icon: String) -> some View {
        let selected = settings.serverEnv == env
        return Button {
            settings.selectEnv(env)
            server = settings.customServer
            healthOK = nil
            healthText = nil
        } label: {
            VStack(spacing: 3) {
                Image(systemName: icon)
                Text(env.title).font(.footnote)
                Text(AppConfig.url(for: env).host ?? "").font(.caption2)
                    .foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(selected ? Color.accentColor.opacity(0.15) : Color.clear)
            .overlay(RoundedRectangle(cornerRadius: 8)
                .strokeBorder(selected ? Color.accentColor : Color.gray.opacity(0.35),
                              lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(.plain)
    }

    private func test() async {
        testing = true
        healthOK = nil
        healthText = nil
        do {
            let health = try await APIClient.shared.get(XZHealth.self, Endpoint.health)
            var lines = ["服务在线：通道 \(health.channel ?? "-")，当前设备 \(health.devices ?? 0) 台"]
            let devices = try await APIClient.shared.get([XZLiveDevice].self, Endpoint.devices)
            lines.append("实时连接：\(devices.filter { $0.isOnline }.count) 台在线（\(settings.displayBaseURL)）")
            healthOK = true
            healthText = lines.joined(separator: "\n")
        } catch let e as APIError {
            healthOK = false
            healthText = e.errorDescription
        } catch {
            healthOK = false
            healthText = error.localizedDescription
        }
        testing = false
    }
}
