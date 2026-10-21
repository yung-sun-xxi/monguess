"""Serve MonGuess on localhost with config.js built from environment variables.

The keys never touch the disk: MG_MAPILLARY_TOKEN and MG_GOOGLE_API_KEY are read
at start and written into the config.js response only.
"""
import http.server
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
CONFIG = ("window.MG_CONFIG = %s;\n" % json.dumps({
    "mapillaryToken": os.environ.get("MG_MAPILLARY_TOKEN", ""),
    "googleApiKey": os.environ.get("MG_GOOGLE_API_KEY", ""),
})).encode()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if self.path.split("?")[0] == "/config.js":
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.end_headers()
            self.wfile.write(CONFIG)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


print(f"MonGuess: http://localhost:{PORT}/  (Ctrl+C to stop)", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
