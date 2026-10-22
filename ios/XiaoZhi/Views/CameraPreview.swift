import SwiftUI
import WebKit

/// MJPEG 摄像头预览：用 WKWebView 直读树莓派 `http://<pi>:8110/stream`（multipart/x-mixed-replace）。
/// SwiftUI AsyncImage / URLSession 无法渲染连续 MJPEG 流，故用 WebKit。
struct CameraPreview: UIViewRepresentable {
    let url: String?

    func makeUIView(context: Context) -> WKWebView {
        let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        web.isOpaque = false
        web.backgroundColor = .black
        web.uiDelegate = context.coordinator
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        guard let str = url, let u = URL(string: str) else {
            web.loadHTMLString(placeholderHTML, baseURL: nil)
            return
        }
        if context.coordinator.lastURL == str { return }
        context.coordinator.lastURL = str
        web.load(URLRequest(url: u))
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
