#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
semi-auto 分析配置生成器 —— 本地服务（带后台管理鉴权）

零第三方依赖，只用 Python 标准库。

页面
  /            公开页：只读，勾选分析类型 → 生成 JSON
  /admin       后台页：需要口令，才能编辑并保存 semi-auto.json

接口
  GET  /api/config      公开：读取配置（含 mtime，供前端热更新）
  GET  /api/mtime       公开：仅返回配置文件修改时间
  POST /api/verify      校验后台口令
  POST /api/config      写回配置        —— 需要口令
  GET  /api/backups     列出历史备份    —— 需要口令
  GET  /api/backup      读取某个备份    —— 需要口令
  POST /api/restore     回滚到某个备份  —— 需要口令

口令
  首次启动自动生成，保存在 .admin-token（仅本机可读）。
  启动时会打印带口令的后台直达链接，浏览器打开一次即可，之后 30 天内免登录。

用法
  python server.py                      # 默认 127.0.0.1:8000，自动开浏览器
  python server.py --port 8123
  python server.py --admin-token mypw   # 指定口令
  python server.py --rotate-token       # 重新生成口令
  python server.py --no-browser --host 0.0.0.0   # 供局域网访问（务必保管好口令）
"""

import argparse
import json
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(ROOT, "semi-auto.json")
LEGACY_BAK = CONFIG_PATH + ".bak"
TOKEN_PATH = os.path.join(ROOT, ".admin-token")
BACKUP_DIR = os.path.join(ROOT, "backups")
MAX_BACKUPS = 30

# 不通过静态服务对外暴露的文件 / 目录
DENY_FILES = {
    "/semi-auto.json",
    "/semi-auto.json.bak",
    "/semi-auto.json.tmp",
    "/server.py",
    "/.admin-token",
}
DENY_PREFIXES = ("/backups/", "/.workbuddy/", "/.git/")

FALLBACK_CONFIG = {
    "version": 1.0,
    "product": {
        "扩增子": {
            "环境因子分析": {
                "分期号": {"required": True, "type": "str"},
                "结果文件": {"required": True, "type": "str"},
                "上传分期": {"required": False, "type": "str"},
                "信息搜集表": {"required": False, "type": "str"},
            }
        }
    },
}

_lock = threading.Lock()
_fails = {"n": 0, "ts": 0.0}


# --------------------------------------------------------------------------- #
# 口令
# --------------------------------------------------------------------------- #
def load_or_create_token(rotate=False):
    if rotate and os.path.exists(TOKEN_PATH):
        os.remove(TOKEN_PATH)
    if os.path.exists(TOKEN_PATH):
        try:
            with open(TOKEN_PATH, "r", encoding="utf-8") as f:
                tok = f.read().strip()
            if tok:
                return tok
        except OSError:
            pass
    tok = secrets.token_urlsafe(24)
    with open(TOKEN_PATH, "w", encoding="utf-8") as f:
        f.write(tok + "\n")
    try:
        os.chmod(TOKEN_PATH, 0o600)
    except OSError:
        pass
    return tok


def token_ok(candidate):
    if not candidate:
        return False
    try:
        return secrets.compare_digest(str(candidate), ADMIN_TOKEN)
    except Exception:  # noqa: BLE001
        return False


def throttle_check():
    """连续试错太多则临时拒绝，返回剩余等待秒数（0 表示可继续）。"""
    with _lock:
        if _fails["n"] >= 6:
            left = 300 - (time.time() - _fails["ts"])
            if left > 0:
                return int(left) + 1
            _fails["n"] = 0
        return 0


def throttle_fail():
    with _lock:
        if time.time() - _fails["ts"] > 300:
            _fails["n"] = 0
        _fails["n"] += 1
        _fails["ts"] = time.time()


def throttle_reset():
    with _lock:
        _fails["n"] = 0
        _fails["ts"] = 0.0


# --------------------------------------------------------------------------- #
# 配置读写
# --------------------------------------------------------------------------- #
def read_config():
    if not os.path.exists(CONFIG_PATH):
        write_config(FALLBACK_CONFIG, backup=False)

    errors = []
    raw = ""
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            with open(CONFIG_PATH, "r", encoding=enc) as f:
                raw = f.read()
            break
        except UnicodeDecodeError as exc:
            errors.append(str(exc))
    if not raw.strip():
        if errors:
            print(f"[warn] 读取配置编码异常：{errors[0]}，使用内置兜底配置")
        return dict(FALLBACK_CONFIG), os.path.getmtime(CONFIG_PATH)

    try:
        config = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] 解析 {CONFIG_PATH} 失败：{exc}，使用内置兜底配置")
        config = dict(FALLBACK_CONFIG)
    return config, os.path.getmtime(CONFIG_PATH)


def write_config(config, backup=True):
    if not isinstance(config, dict):
        raise ValueError("配置顶层必须是 JSON 对象")

    if backup:
        make_backup()

    payload = json.dumps(config, ensure_ascii=False, indent=4)
    tmp_path = CONFIG_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(payload)
        f.write("\n")
    os.replace(tmp_path, CONFIG_PATH)
    try:
        os.utime(CONFIG_PATH, None)
    except OSError:
        pass
    return os.path.getmtime(CONFIG_PATH)


# --------------------------------------------------------------------------- #
# 备份
# --------------------------------------------------------------------------- #
def make_backup():
    if not os.path.exists(CONFIG_PATH):
        return None
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        name = "semi-auto-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".json"
        shutil.copyfile(CONFIG_PATH, os.path.join(BACKUP_DIR, name))
        files = sorted(f for f in os.listdir(BACKUP_DIR)
                       if f.startswith("semi-auto-") and f.endswith(".json"))
        for old in files[:-MAX_BACKUPS]:
            try:
                os.remove(os.path.join(BACKUP_DIR, old))
            except OSError:
                pass
        return name
    except OSError as exc:
        print(f"[warn] 备份失败：{exc}")
        return None


def list_backups():
    if not os.path.isdir(BACKUP_DIR):
        return []
    out = []
    for name in sorted(os.listdir(BACKUP_DIR), reverse=True):
        if not (name.startswith("semi-auto-") and name.endswith(".json")):
            continue
        path = os.path.join(BACKUP_DIR, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        out.append({"name": name, "size": st.st_size, "mtime": st.st_mtime})
    return out


def backup_path(name):
    """防止路径穿越：只允许 backups 目录下合法命名的文件。"""
    if not name or not re.fullmatch(r"semi-auto-\d{8}-\d{6}\.json", name):
        return None
    path = os.path.join(BACKUP_DIR, name)
    if not os.path.exists(path):
        return None
    return path


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class Handler(SimpleHTTPRequestHandler):
    server_version = "SemiAutoConfig/2.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # -- 工具 -------------------------------------------------------------- #
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        return self.rfile.read(length) if length > 0 else b""

    def _json_body(self):
        raw = self._read_body()
        return json.loads(raw.decode("utf-8") or "{}")

    def _token_from_request(self, query=None):
        tok = self.headers.get("X-Admin-Token")
        if not tok and query:
            tok = (query.get("token") or [""])[0]
        return tok

    def _require_auth(self, query=None):
        """返回 True 表示已授权；否则已发出 401/429 响应。"""
        left = throttle_check()
        if left:
            self._send_json({"ok": False, "error": f"尝试次数过多，请 {left} 秒后再试"}, 429)
            return False
        if token_ok(self._token_from_request(query)):
            return True
        throttle_fail()
        self._send_json({"ok": False, "error": "未授权：请先登录后台"}, 401)
        return False

    # -- GET --------------------------------------------------------------- #
    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        if path == "/api/config":
            try:
                config, mtime = read_config()
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)}, 500)
                return
            self._send_json({"ok": True, "mtime": mtime, "path": CONFIG_PATH, "config": config})
            return

        if path == "/api/mtime":
            try:
                mtime = os.path.getmtime(CONFIG_PATH)
            except OSError:
                mtime = 0
            self._send_json({"ok": True, "mtime": mtime})
            return

        if path == "/api/backups":
            if not self._require_auth(query):
                return
            self._send_json({"ok": True, "backups": list_backups()})
            return

        if path == "/api/backup":
            if not self._require_auth(query):
                return
            bp = backup_path((query.get("name") or [""])[0])
            if not bp:
                self._send_json({"ok": False, "error": "备份不存在"}, 404)
                return
            try:
                with open(bp, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)}, 500)
                return
            self._send_json({"ok": True, "config": cfg})
            return

        # 静态资源：屏蔽配置与敏感文件
        if self._is_denied(path):
            self._send_json({"ok": False, "error": "禁止访问"}, 403)
            return

        if path in ("/admin", "/admin/"):
            self.path = "/admin.html"
        elif path == "/":
            self.path = "/index.html"
        return super().do_GET()

    # -- POST -------------------------------------------------------------- #
    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        if self.server.server_address[0] not in ("127.0.0.1", "localhost", "::1"):
            # 非本机访问时，要求同源，降低被第三方页面代发的风险
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
                self._send_json({"ok": False, "error": "跨站请求被拒绝"}, 403)
                return

        if path == "/api/verify":
            left = throttle_check()
            if left:
                self._send_json({"ok": False, "error": f"尝试次数过多，请 {left} 秒后再试"}, 429)
                return
            try:
                data = self._json_body()
            except Exception:  # noqa: BLE001
                data = {}
            if token_ok(data.get("token") or self._token_from_request(query)):
                throttle_reset()
                self._send_json({"ok": True})
            else:
                throttle_fail()
                self._send_json({"ok": False, "error": "口令错误"}, 401)
            return

        if path == "/api/config":
            if not self._require_auth(query):
                return
            try:
                data = self._json_body()
            except json.JSONDecodeError as exc:
                self._send_json({"ok": False, "error": f"JSON 语法错误：{exc}"}, 400)
                return
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)}, 400)
                return
            config = data.get("config", data)
            try:
                json.dumps(config, ensure_ascii=False)
                mtime = write_config(config)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)}, 400)
                return
            self._send_json({"ok": True, "mtime": mtime, "path": CONFIG_PATH})
            return

        if path == "/api/restore":
            if not self._require_auth(query):
                return
            try:
                data = self._json_body()
            except Exception:  # noqa: BLE001
                data = {}
            bp = backup_path(data.get("name") or "")
            if not bp:
                self._send_json({"ok": False, "error": "备份不存在"}, 404)
                return
            try:
                with open(bp, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                mtime = write_config(cfg)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"ok": False, "error": str(exc)}, 400)
                return
            self._send_json({"ok": True, "mtime": mtime, "config": cfg})
            return

        self._send_json({"ok": False, "error": "未知接口"}, 404)

    # -- 其它 -------------------------------------------------------------- #
    def _is_denied(self, path):
        if path in DENY_FILES:
            return True
        return any(path.startswith(p) for p in DENY_PREFIXES)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            sys.stderr.write(f"  [api] {fmt % args}\n")


# --------------------------------------------------------------------------- #
# 启动
# --------------------------------------------------------------------------- #
def find_free_port(preferred, tries=40):
    for port in range(preferred, preferred + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit(f"找不到空闲端口（尝试范围 {preferred}-{preferred + tries}）")


ADMIN_TOKEN = ""


def main():
    global ADMIN_TOKEN

    parser = argparse.ArgumentParser(description="semi-auto 分析配置生成器本地服务")
    parser.add_argument("--port", type=int, default=8000, help="监听端口（默认 8000）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认仅本机）")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--open-admin", action="store_true", help="直接打开后台管理页")
    parser.add_argument("--admin-token", help="指定后台口令（默认自动生成）")
    parser.add_argument("--rotate-token", action="store_true", help="重新生成后台口令")
    args = parser.parse_args()

    if args.admin_token:
        ADMIN_TOKEN = args.admin_token
        with open(TOKEN_PATH, "w", encoding="utf-8") as f:
            f.write(ADMIN_TOKEN + "\n")
    else:
        ADMIN_TOKEN = load_or_create_token(rotate=args.rotate_token)

    try:
        read_config()
    except Exception:  # noqa: BLE001
        pass

    port = find_free_port(args.port)
    host_shown = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    base = f"http://{host_shown}:{port}"
    admin_url = f"{base}/admin?token={ADMIN_TOKEN}"

    httpd = ThreadingHTTPServer((args.host, port), Handler)
    print("=" * 70)
    print("  semi-auto 分析配置生成器")
    print("=" * 70)
    print(f"  配置文件   : {CONFIG_PATH}")
    print(f"  公开页面   : {base}/            （只读，任何人可访问）")
    print(f"  后台管理   : {base}/admin       （需要口令）")
    print(f"  备份目录   : {BACKUP_DIR}")
    print("-" * 70)
    print("  请妥善保管下面的后台直达链接（含口令，打开一次即可免登录 30 天）：")
    print(f"  {admin_url}")
    print("=" * 70)
    print("  停止服务 : Ctrl + C")
    print("=" * 70)

    if not args.no_browser:
        target = admin_url if args.open_admin else base + "/"
        threading.Thread(
            target=lambda: (time.sleep(0.6), webbrowser.open(target)),
            daemon=True,
        ).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止服务。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
