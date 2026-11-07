"""The Arc bench page with COOP/COEP (cross-origin isolated, so the threaded build gets SharedArrayBuffer).
python3 serve_isolated.py [port] -> http://<mac>:8094/bench.html (serves $ARCWASM_ROOT, default ../app/public/arcwasm)"""
import http.server, os, sys, functools
ROOT = os.environ.get("ARCWASM_ROOT", "../app/public/arcwasm")
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".wasm": "application/wasm"}
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 8094), functools.partial(H, directory=ROOT)).serve_forever()
