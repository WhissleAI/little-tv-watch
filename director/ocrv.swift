// ocrv: Apple Vision text recognition over frames, one JSON line per frame:
//   {"f": path, "w": [[text, conf, x0, y0, x1, y1], ...]}   boxes in frame fractions, origin top-left
// usage: ocrv [--strips] frame.jpg ...   (--strips: only the top 28% and bottom 32% of the frame, where score bugs sit)
import Foundation
import Vision
import AppKit

var args = Array(CommandLine.arguments.dropFirst())
let strips = args.first == "--strips"
if strips { args.removeFirst() }
let out = FileHandle.standardOutput
for path in args {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
    var words: [[Any]] = []
    let regions: [CGRect] = strips ? [CGRect(x: 0, y: 0.72, width: 1, height: 0.28), CGRect(x: 0, y: 0, width: 1, height: 0.32)]
                                   : [CGRect(x: 0, y: 0, width: 1, height: 1)]
    for roi in regions {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = false
        req.regionOfInterest = roi   // Vision's normalised coords: origin bottom-left
        let h = VNImageRequestHandler(cgImage: cg, options: [:])
        try? h.perform([req])
        for o in req.results ?? [] {
            guard let c = o.topCandidates(1).first else { continue }
            // boundingBox is relative to the ROI; map back to the whole frame, origin top-left
            let b = o.boundingBox
            let x0 = roi.minX + b.minX * roi.width, x1 = roi.minX + b.maxX * roi.width
            let y0 = 1 - (roi.minY + b.maxY * roi.height), y1 = 1 - (roi.minY + b.minY * roi.height)
            words.append([c.string, Double(c.confidence), x0, y0, x1, y1])
        }
    }
    let line: [String: Any] = ["f": path, "w": words]
    if let d = try? JSONSerialization.data(withJSONObject: line) { out.write(d); out.write("\n".data(using: .utf8)!) }
}
