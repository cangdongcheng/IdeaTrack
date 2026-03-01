#!/usr/bin/env python3
"""IdeaTrack backend — static file server + Ollama proxy."""

import json
import mimetypes
import os
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = '127.0.0.1'
PORT = 5000
STATIC_DIR = os.path.join(os.path.dirname(__file__), 'static')
OLLAMA_URL = 'http://localhost:11434/v1/chat/completions'

STATIC_FILES = {
    '/':           'index.html',
    '/index.html': 'index.html',
    '/style.css':  'style.css',
    '/app.js':     'app.js',
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f'  {self.address_string()} {fmt % args}')

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        filename = STATIC_FILES.get(self.path)
        if filename is None:
            self.send_json(404, {'error': 'Not found'})
            return

        filepath = os.path.join(STATIC_DIR, filename)
        try:
            with open(filepath, 'rb') as f:
                body = f.read()
        except FileNotFoundError:
            self.send_json(404, {'error': f'{filename} not found'})
            return

        mime, _ = mimetypes.guess_type(filename)
        self.send_response(200)
        self.send_header('Content-Type', mime or 'application/octet-stream')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/api/chat':
            self.send_json(404, {'error': 'Not found'})
            return

        length = int(self.headers.get('Content-Length', 0))
        payload = self.rfile.read(length)

        try:
            is_stream = json.loads(payload).get('stream', False)
        except Exception:
            is_stream = False

        req = urllib.request.Request(
            OLLAMA_URL,
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                if is_stream:
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Cache-Control', 'no-cache')
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    try:
                        while True:
                            chunk = resp.read(256)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                else:
                    body = resp.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', len(body))
                    self.end_headers()
                    self.wfile.write(body)
        except urllib.error.URLError:
            self.send_json(502, {'error': 'Ollama not running'})


if __name__ == '__main__':
    server = HTTPServer((HOST, PORT), Handler)
    url = f'http://localhost:{PORT}'
    print(f'IdeaTrack running → {url}')

    # Auto-open browser
    try:
        import webbrowser
        webbrowser.open(url)
    except Exception:
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
