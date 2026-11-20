#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
เซิร์ฟเวอร์เล็ก ๆ สำหรับระบบจดวันลา
- เสิร์ฟหน้าเว็บ index.html
- เก็บข้อมูลลงไฟล์จริง data.json (เขียนแบบ atomic + สำรองเวอร์ชันก่อนหน้าไว้ในโฟลเดอร์ backups)

วิธีรัน:  python server.py [พอร์ต]
เปิดเว็บ: http://localhost:8777
ใช้ไลบรารีมาตรฐานของ Python ล้วน ไม่ต้องติดตั้งอะไรเพิ่ม
"""
import json, os, sys, glob, shutil, tempfile
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(ROOT, "data.json")
BACKUP_DIR = os.path.join(ROOT, "backups")
KEEP_BACKUPS = 20
EMPTY = {"minStaff": 2, "members": [], "leaves": []}


def read_data():
    if not os.path.exists(DATA_FILE):
        return dict(EMPTY)
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict) or "members" not in d or "leaves" not in d:
            raise ValueError("โครงสร้างข้อมูลไม่ถูกต้อง")
        return d
    except Exception as e:
        print("[warn] อ่าน data.json ไม่ได้:", e)
        return dict(EMPTY)


def backup_current():
    """สำรองไฟล์เดิมก่อนเขียนทับ เก็บไว้ KEEP_BACKUPS ชุดล่าสุด"""
    if not os.path.exists(DATA_FILE):
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(DATA_FILE, os.path.join(BACKUP_DIR, "data-%s.json" % stamp))
    old = sorted(glob.glob(os.path.join(BACKUP_DIR, "data-*.json")))[:-KEEP_BACKUPS]
    for p in old:
        try:
            os.remove(p)
        except OSError:
            pass


def write_data(d):
    """เขียนแบบ atomic: เขียนไฟล์ชั่วคราวให้เสร็จก่อน แล้วค่อยสลับทับของเดิม
    ถ้าไฟดับหรือโปรแกรมตายกลางคัน ไฟล์เดิมจะไม่พัง"""
    backup_current()
    d = dict(d)
    d["savedAt"] = datetime.now().isoformat(timespec="seconds")
    fd, tmp = tempfile.mkstemp(dir=ROOT, prefix=".data-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, DATA_FILE)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    return d


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # กันเบราว์เซอร์แคชหน้าเว็บเก่า
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/api/data":
            return self._send_json(200, {"ok": True, "data": read_data()})
        return super().do_GET()

    def do_PUT(self):
        if self.path.split("?")[0] != "/api/data":
            return self._send_json(404, {"ok": False, "error": "ไม่พบปลายทางนี้"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 5_000_000:
                raise ValueError("ขนาดข้อมูลไม่ถูกต้อง")
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("ต้องเป็น JSON object")
            if not isinstance(payload.get("members"), list) or not isinstance(payload.get("leaves"), list):
                raise ValueError("ต้องมี members และ leaves เป็น list")
            saved = write_data(payload)
            self._send_json(200, {"ok": True, "savedAt": saved["savedAt"],
                                  "file": os.path.basename(DATA_FILE)})
        except Exception as e:
            self._send_json(400, {"ok": False, "error": str(e)})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("ระบบจดวันลา — http://localhost:%d" % port)
    print("ไฟล์ข้อมูล: %s" % DATA_FILE)
    print("สำรองอัตโนมัติ: %s (เก็บ %d ชุดล่าสุด)" % (BACKUP_DIR, KEEP_BACKUPS))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nปิดเซิร์ฟเวอร์แล้ว")
