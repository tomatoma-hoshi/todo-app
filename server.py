#!/usr/bin/env python3
"""
Todo app server — HTTP REST + Server-Sent Events on a single port.
"""
import json
import os
import queue
import socket
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR / "data" / "todos.json"
PUBLIC_DIR = BASE_DIR / "public"
PORT = int(os.environ.get("PORT", 3000))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css":  "text/css",
    ".js":   "application/javascript",
}

# ── Data ──────────────────────────────────────────────────

_data_lock = threading.Lock()

def load_data():
    if not DATA_FILE.exists():
        _write_json({"tasks": []})
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"tasks": []}

def _write_json(data):
    DATA_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

def save_data(data):
    with _data_lock:
        _write_json(data)

def now_iso():
    return datetime.now(timezone.utc).isoformat()

# ── SSE broadcast ─────────────────────────────────────────

_subscribers: list[queue.Queue] = []
_subs_lock = threading.Lock()

def subscribe():
    q = queue.Queue()
    with _subs_lock:
        _subscribers.append(q)
    return q

def unsubscribe(q):
    with _subs_lock:
        _subscribers.remove(q)

def broadcast(message: dict):
    data = json.dumps(message, ensure_ascii=False)
    payload = f"data: {data}\n\n".encode()
    with _subs_lock:
        dead = []
        for q in _subscribers:
            try:
                q.put_nowait(payload)
            except queue.Full:
                dead.append(q)
        for q in dead:
            _subscribers.remove(q)

# ── HTTP handler ──────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    # ── GET ──
    def do_GET(self):
        path = self.path.split("?")[0]

        if path == "/api/tasks":
            self.send_json(200, load_data())
            return

        if path == "/api/events":
            self._handle_sse()
            return

        if path == "/":
            path = "/index.html"
        file_path = PUBLIC_DIR / path.lstrip("/")
        if file_path.exists() and file_path.is_file():
            body = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", MIME.get(file_path.suffix, "application/octet-stream"))
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_json(404, {"error": "Not found"})

    def _handle_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        # Send current state
        init = json.dumps({"type": "init", "data": load_data()}, ensure_ascii=False)
        try:
            self.wfile.write(f"data: {init}\n\n".encode())
            self.wfile.flush()
        except Exception:
            return

        q = subscribe()
        try:
            while True:
                try:
                    payload = q.get(timeout=30)
                    self.wfile.write(payload)
                    self.wfile.flush()
                except queue.Empty:
                    # heartbeat
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
        except Exception:
            pass
        finally:
            unsubscribe(q)

    # ── POST ──
    def do_POST(self):
        path = self.path.split("?")[0]
        body = self.read_body()

        if path == "/api/tasks":
            data = load_data()
            parent_id = body.get("parentId") or None
            siblings = [t for t in data["tasks"] if t.get("parentId") == parent_id]
            task = {
                "id": str(uuid.uuid4()),
                "title": body.get("title", ""),
                "description": body.get("description", ""),
                "completed": False,
                "parentId": parent_id,
                "order": body.get("order", len(siblings)),
                "linkedTaskIds": [],
                "createdAt": now_iso(),
                "updatedAt": now_iso(),
            }
            data["tasks"].append(task)
            save_data(data)
            broadcast({"type": "task:created", "task": task})
            self.send_json(200, task)

        elif path == "/api/tasks/reorder":
            data = load_data()
            parent_id = body.get("parentId") or None
            for i, tid in enumerate(body.get("orderedIds", [])):
                for t in data["tasks"]:
                    if t["id"] == tid:
                        t["order"] = i
                        t["parentId"] = parent_id
                        t["updatedAt"] = now_iso()
            save_data(data)
            broadcast({"type": "task:reordered", "parentId": parent_id, "orderedIds": body.get("orderedIds", [])})
            self.send_json(200, {"ok": True})

        elif path.startswith("/api/tasks/") and path.endswith("/link"):
            tid = path[len("/api/tasks/"):-len("/link")]
            data = load_data()
            task = next((t for t in data["tasks"] if t["id"] == tid), None)
            target_id = body.get("targetId")
            if not task or not any(t["id"] == target_id for t in data["tasks"]):
                self.send_json(404, {"error": "Not found"})
                return
            if target_id not in task["linkedTaskIds"]:
                task["linkedTaskIds"].append(target_id)
                task["updatedAt"] = now_iso()
            save_data(data)
            broadcast({"type": "task:updated", "task": task})
            self.send_json(200, task)

        else:
            self.send_json(404, {"error": "Not found"})

    # ── PUT ──
    def do_PUT(self):
        path = self.path.split("?")[0]
        if not path.startswith("/api/tasks/"):
            self.send_json(404, {"error": "Not found"})
            return
        tid = path[len("/api/tasks/"):]
        body = self.read_body()
        data = load_data()
        task = next((t for t in data["tasks"] if t["id"] == tid), None)
        if not task:
            self.send_json(404, {"error": "Not found"})
            return
        for k, v in body.items():
            if k != "id":
                task[k] = v
        task["updatedAt"] = now_iso()
        save_data(data)
        broadcast({"type": "task:updated", "task": task})
        self.send_json(200, task)

    # ── DELETE ──
    def do_DELETE(self):
        path = self.path.split("?")[0]
        if not path.startswith("/api/tasks/"):
            self.send_json(404, {"error": "Not found"})
            return
        parts = path[len("/api/tasks/"):].split("/")

        if len(parts) == 3 and parts[1] == "link":
            tid, _, target_id = parts
            data = load_data()
            task = next((t for t in data["tasks"] if t["id"] == tid), None)
            if not task:
                self.send_json(404, {"error": "Not found"})
                return
            task["linkedTaskIds"] = [l for l in task["linkedTaskIds"] if l != target_id]
            task["updatedAt"] = now_iso()
            save_data(data)
            broadcast({"type": "task:updated", "task": task})
            self.send_json(200, task)
        else:
            tid = parts[0]
            data = load_data()
            to_delete: set[str] = set()

            def collect(i):
                to_delete.add(i)
                for t in data["tasks"]:
                    if t.get("parentId") == i:
                        collect(t["id"])

            collect(tid)
            data["tasks"] = [t for t in data["tasks"] if t["id"] not in to_delete]
            for t in data["tasks"]:
                t["linkedTaskIds"] = [l for l in t["linkedTaskIds"] if l not in to_delete]
            save_data(data)
            broadcast({"type": "task:deleted", "ids": list(to_delete)})
            self.send_json(200, {"deleted": list(to_delete)})

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

# ── Main ──────────────────────────────────────────────────

class ThreadedHTTPServer(HTTPServer):
    def process_request(self, request, client_address):
        t = threading.Thread(target=self._process_request, args=(request, client_address))
        t.daemon = True
        t.start()

    def _process_request(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            pass

if __name__ == "__main__":
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = "localhost"

    httpd = ThreadedHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Todo app running:")
    print(f"  Local:  http://localhost:{PORT}")
    print(f"  LAN:    http://{local_ip}:{PORT}")
    print(f"  Internet: run `ngrok http {PORT}` in another terminal")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
