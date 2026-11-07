// scgrab: the Little simulator's app stage, ~2 fps, as a JPEG at a fixed path (atomically replaced).
//   scgrab <out.jpg> [window title, default "Little · dev"] [fps, default 2]
// SIMULATOR-ONLY: on a real Little TV an app can't capture the screen. TV Watch uses this so its scoreboard reader
// can see a YouTube player, whose pixels the page itself may not read (another origin).
// The stage is the app's 16:9 canvas inside the window: below the title bar, letterboxed; it is cropped and
// scaled to 1920x1080 so the reader's boxes are in the app's own coordinates.
import AppKit
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

final class Grab: NSObject, SCStreamOutput, SCStreamDelegate {
  let out: URL
  let tmp: URL
  let ci = CIContext()
  let titlebar: CGFloat
  var last = Date.distantPast
  let every: TimeInterval
  init(out: URL, titlebar: CGFloat, fps: Double) {
    self.out = out
    self.tmp = out.deletingLastPathComponent().appendingPathComponent(".scgrab.tmp.jpg")
    self.titlebar = titlebar
    self.every = 1.0 / fps
  }
  func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sb.isValid, let px = CMSampleBufferGetImageBuffer(sb) else { return }
    guard Date().timeIntervalSince(last) >= every else { return }
    last = Date()
    let img = CIImage(cvPixelBuffer: px)
    let W = img.extent.width, H = img.extent.height
    // CIImage's origin is bottom-left: the content area is everything but the title bar strip at the top
    let contentH = H - titlebar
    var sw = W, sh = W * 9 / 16
    if sh > contentH { sh = contentH; sw = sh * 16 / 9 }
    let stage = CGRect(x: (W - sw) / 2, y: (contentH - sh) / 2, width: sw, height: sh)
    let scaled = img.cropped(to: stage)
      .transformed(by: CGAffineTransform(translationX: -stage.minX, y: -stage.minY))
      .transformed(by: CGAffineTransform(scaleX: 1920 / sw, y: 1080 / sh))
    guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
          let data = ci.jpegRepresentation(of: scaled, colorSpace: cs,
                                           options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.85])
    else { return }
    try? data.write(to: tmp)
    _ = rename(tmp.path, out.path)   // atomic: a reader never gets half a JPEG
  }
  func stream(_ s: SCStream, didStopWithError e: Error) { print("stopped: \(e)"); fflush(stdout); exit(2) }
}

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: scgrab <out.jpg> [title] [fps]"); exit(1) }
let title = args.count > 2 ? args[2] : "Little · dev"
let fps = args.count > 3 ? Double(args[3]) ?? 2 : 2
_ = NSApplication.shared
var keep: (SCStream, Grab)?
Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let win = content.windows.first(where: { ($0.title ?? "") == title }) else { print("no window titled \(title)"); exit(1) }
    // Window-only capture comes back black while a video plays (Chromium draws video in its own layers), so take
    // the display with only Electron's processes in it, cropped to the window (the film recorder's way).
    guard let display = content.displays.first(where: { $0.frame.intersects(win.frame) }) ?? content.displays.first else { exit(1) }
    let owner = win.owningApplication?.applicationName ?? "Electron"
    let others = content.applications.filter { !$0.applicationName.hasPrefix(owner) && !$0.bundleIdentifier.contains("electron") }
    let filter = SCContentFilter(display: display, excludingApplications: others, exceptingWindows: [])
    let cfg = SCStreamConfiguration()
    let scale = 2.0
    cfg.sourceRect = CGRect(x: win.frame.minX - display.frame.minX, y: win.frame.minY - display.frame.minY,
                            width: win.frame.width, height: win.frame.height)
    cfg.width = Int(win.frame.width * scale)
    cfg.height = Int(win.frame.height * scale)
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, Int(fps * 2))))
    cfg.showsCursor = false
    cfg.queueDepth = 3
    let g = Grab(out: URL(fileURLWithPath: args[1]), titlebar: 28 * scale, fps: fps)
    let s = SCStream(filter: filter, configuration: cfg, delegate: g)
    try s.addStreamOutput(g, type: .screen, sampleHandlerQueue: DispatchQueue(label: "grab"))
    try await s.startCapture()
    keep = (s, g)
    print("grabbing window \(win.windowID) \(Int(win.frame.width))x\(Int(win.frame.height)) -> \(args[1])"); fflush(stdout)
  } catch {
    print("error: \(error)"); fflush(stdout)
    exit(1)
  }
}
dispatchMain()
