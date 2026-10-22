import SwiftUI

/// 设备在线状态徽章
struct StatusBadge: View {
    enum Kind { case online, resting, offline
        var text: String {
            switch self {
            case .online: return "● 在线"
            case .resting: return "☾ 休息"
            case .offline: return "○ 离线"
            }
        }
        var color: Color {
            switch self {
            case .online: return .green
            case .resting: return .orange
            case .offline: return .secondary
            }
        }
    }

    let kind: Kind

    var body: some View {
        Text(kind.text)
            .font(.system(.caption2, design: .monospaced).weight(.semibold))
            .foregroundStyle(kind.color)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(kind.color.opacity(0.12), in: Capsule())
            .overlay(Capsule().stroke(kind.color.opacity(0.4), lineWidth: 0.5))
    }
}

/// 相对时间文案（"x 分钟前"），用于 last_seen 毫秒 epoch
func xzRelativeTime(_ epochMs: Int?) -> String {
    guard let ms = epochMs, ms > 0 else { return "-" }
    let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.unitsStyle = .short
    return formatter.localizedString(for: date, relativeTo: Date())
}
