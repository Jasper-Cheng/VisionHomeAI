#!/usr/bin/env python3
"""
VisionHomeAI 本地开发：提供静态资源，并将「保存方案」POST 写入 assets/data/design/ 且更新 manifest.json。

用法（项目根目录）：
  python3 scripts/dev_server.py
  PORT=3000 python3 scripts/dev_server.py

浏览器访问 http://localhost:8080/index.html（默认端口 8080）。
纯静态场景仍可使用：python3 -m http.server 8080（此时保存会回退为下载 JSON）。
"""
from __future__ import annotations

import json
import os
import re
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", "8080"))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESIGN_DIR = os.path.join(ROOT, "assets", "data", "design")
MANIFEST_PATH = os.path.join(DESIGN_DIR, "manifest.json")

FILENAME_OK = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json$")


def ensure_manifest() -> None:
    os.makedirs(DESIGN_DIR, exist_ok=True)
    if not os.path.isfile(MANIFEST_PATH):
        with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
            json.dump({"schemaVersion": "1.0", "files": []}, f, indent=2)
            f.write("\n")


class DevHTTPRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/design/save":
            self.send_error(404, "Not Found")
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self.send_error(400, "Bad Content-Length")
            return
        if length <= 0 or length > 8 * 1024 * 1024:
            self.send_error(400, "Bad body size")
            return
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_error(400, "Invalid JSON")
            return
        filename = body.get("filename")
        project = body.get("project")
        if not isinstance(filename, str) or not isinstance(project, dict):
            self.send_error(400, "Missing filename or project")
            return
        filename = os.path.basename(filename.strip())
        if not FILENAME_OK.match(filename):
            self.send_error(400, "Invalid filename")
            return
        design_dir_real = os.path.realpath(DESIGN_DIR)
        ensure_manifest()
        path = os.path.realpath(os.path.join(DESIGN_DIR, filename))
        if not path.startswith(design_dir_real + os.sep) and path != design_dir_real:
            self.send_error(400, "Invalid path")
            return
        text = json.dumps(project, ensure_ascii=False, indent=2) + "\n"
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
        except OSError as e:
            self.send_error(500, str(e))
            return
        try:
            with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except (OSError, json.JSONDecodeError):
            manifest = {"schemaVersion": "1.0", "files": []}
        files = manifest.get("files")
        if not isinstance(files, list):
            files = []
        if filename not in files:
            files.append(filename)
            manifest["files"] = files
        manifest.setdefault("schemaVersion", "1.0")
        try:
            with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
                json.dump(manifest, f, indent=2, ensure_ascii=False)
                f.write("\n")
        except OSError as e:
            self.send_error(500, f"manifest: {e}")
            return
        out = json.dumps({"ok": True, "file": filename}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def main() -> None:
    os.chdir(ROOT)
    httpd = HTTPServer(("", PORT), DevHTTPRequestHandler)
    print(f"VisionHomeAI dev server  http://localhost:{PORT}/  (root={ROOT})")
    print("保存方案 → assets/data/design/  + 更新 manifest.json")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
