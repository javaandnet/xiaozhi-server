import SwiftUI
import WebKit

/// MJPEG 摄像头预览：用 WKWebView 读 multipart/x-mixed-replace 流。
/// 在家直连树莓派 `http://<pi>:8110/stream`；外出（连云端 hub）改读
/// `/api/peer/camera/feed` 帧中继，需带 X-Peer-Key 头（由调用方传入 headers）。
/// SwiftUI AsyncImage / URLSession 无法渲染连续 MJPEG 流，故用 WebKit。
struct CameraPreview: UIViewRepresentable {
    let url: String?
    var headers: [String: String] = [:]

    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        web.isOpaque = false
        web.backgroundColor = .black
        web.uiDelegate = context.coordinator
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        guard let str = url, let u = URL(string: str) else {
            context.coordinator.lastURL = nil
            web.loadHTMLString(placeholderHTML, baseURL: nil)
            return
        }
        let token = str + "#" + headers.keys.sorted().joined(separator: ",")
        if context.coordinator.lastURL == token { return }
        context.coordinator.lastURL = token
        var req = URLRequest(url: u)
        for (k, v) in headers where !v.isEmpty { req.setValue(v, forHTTPHeaderField: k) }
        web.load(req)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKUIDelegate {
        var lastURL: String?
    }

    private var placeholderHTML: String {
        """
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
        <body style="margin:0;background:#000;color:#888;display:flex;align-items:center;justify-content:center;height:100vh;font-family:-apple-system;">
        <div style="text-align:center;">摄像头预览未启动</div></body></html>
        """
    }
}
