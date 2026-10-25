"""Static server for the editor page that also saves a browser POST.

Used to capture the bytes the editor produces in the browser, so the file it
downloads can be compared byte-for-byte with the Python path and written into a
save slot with tools/hdd_save.py.

Run from the folder that holds the editor (so index.html is reachable), then
open the page through it:

    python3 tools/browser_capture.py 8765
    # page: http://127.0.0.1:8765/NFSU2-Savegame-Editor/index.html

In the page, after applying changes:

    fetch('/upload?out=/tmp/opencode/editor_out.bin', {method: 'POST', body: workBuf})

POST bodies are only written under the prefix given by --allow (default
/tmp/opencode/), so the server cannot be used to overwrite workspace files.
"""

import http.server
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    allow = "/tmp/opencode/"

    def do_POST(self):
        n = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(n)
        query = self.path.split("?", 1)
        out = None
        if len(query) > 1:
            for part in query[1].split("&"):
                if part.startswith("out="):
                    out = part[4:]
        if not out or not out.startswith(self.allow):
            self.send_error(400, f"out= must be under {self.allow}")
            return
        with open(out, "wb") as f:
            f.write(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(f"{len(body)} bytes -> {out}\n".encode())

    def log_message(self, fmt, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    for i, arg in enumerate(sys.argv[2:], start=2):
        if arg == "--allow" and len(sys.argv) > i + 1:
            Handler.allow = sys.argv[i + 1]
    print(f"port {port}, POST /upload?out=... writes under {Handler.allow}")
    http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
