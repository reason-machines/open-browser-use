#!/usr/bin/env python3
"""Serve bench fixtures. Pages are reached as http://127.0.0.1:PORT/ and embed
iframes from http://localhost:PORT/ so they become cross-site (OOPIF) frames."""
import http.server, socketserver, sys, os, functools
port = int(sys.argv[1]) if len(sys.argv) > 1 else 18731
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, *a):
        pass

socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("127.0.0.1", port), functools.partial(H, directory=root)) as s:
    print(f"fixtures on http://127.0.0.1:{port}/", flush=True)
    s.serve_forever()
