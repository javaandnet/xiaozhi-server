import Foundation

extension String {
    /// 去首尾空白，UI 判空/提交统一口径
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
