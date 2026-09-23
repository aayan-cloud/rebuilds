"""Local stats agent for the Machine dashboard.

    uv run python dashboard/server.py            # then open the page

Serves JSON on http://127.0.0.1:8799/stats: GPU from nvidia-smi, CPU and memory
from psutil, the model server from the Agentic OS, and vault counts. Binds to
loopback only - nothing here is exposed to the network.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psutil

PORT = 8799
# Point this at your own vault: set VAULT_ROOT, or the vault card shows zeros.
VAULT_ROOT = Path(os.environ.get("VAULT_ROOT", r"C:\Users\Aayan\Documents\Agenitc OS"))
MODEL_PORT = 18500
CACHE_SECONDS = 0.5

_cache: dict = {"at": 0.0, "data": None}
CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

# psutil tracks "CPU since the last call" per thread, and ThreadingHTTPServer
# answers every request on a fresh thread - so calling cpu_percent() in the
# handler always read 0%. One sampler thread owns the counters instead, and
# measures network throughput the same way.
_live: dict = {"percent": 0, "perCore": [], "downMbps": 0.0, "upMbps": 0.0}


def _sample_forever(period: float = 1.0) -> None:
    psutil.cpu_percent(interval=None)
    psutil.cpu_percent(interval=None, percpu=True)
    last, last_t = psutil.net_io_counters(), time.time()
    while True:
        time.sleep(period)
        now, now_t = psutil.net_io_counters(), time.time()
        dt = max(now_t - last_t, 1e-3)
        _live.update(
            percent=int(psutil.cpu_percent(interval=None)),
            perCore=[int(v) for v in psutil.cpu_percent(interval=None, percpu=True)],
            downMbps=round((now.bytes_recv - last.bytes_recv) * 8 / dt / 1e6, 2),
            upMbps=round((now.bytes_sent - last.bytes_sent) * 8 / dt / 1e6, 2),
        )
        last, last_t = now, now_t


def _run(cmd: list[str], timeout: float = 2.0) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                              creationflags=CREATE_NO_WINDOW).stdout
    except Exception:
        return ""


def gpu() -> dict:
    if not shutil.which("nvidia-smi"):
        return {"name": "no nvidia-smi", "vramUsedMiB": 0, "vramTotalMiB": 1,
                "utilPct": 0, "tempC": None, "powerW": None}
    out = _run(["nvidia-smi",
                "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits"]).strip()
    if not out:
        return {"name": "unavailable", "vramUsedMiB": 0, "vramTotalMiB": 1,
                "utilPct": 0, "tempC": None, "powerW": None}
    name, used, total, util, temp, power = [p.strip() for p in out.splitlines()[0].split(",")]
    return {
        "name": name.replace("NVIDIA GeForce ", ""),
        "vramUsedMiB": int(float(used)), "vramTotalMiB": int(float(total)),
        "utilPct": int(float(util)), "tempC": int(float(temp)),
        "powerW": int(float(power)) if power.replace(".", "").isdigit() else None,
    }


def model() -> dict:
    """The llama-server the vault's Hermes setup talks to."""
    info = {"running": False, "port": MODEL_PORT, "pid": None, "asleep": None,
            "name": None, "ctx": None}
    for proc in psutil.process_iter(["name", "cmdline"]):
        if (proc.info["name"] or "").lower() != "llama-server.exe":
            continue
        cmd = proc.info["cmdline"] or []
        if "--port" not in cmd or str(MODEL_PORT) not in cmd:
            continue
        info["running"] = True
        info["pid"] = proc.pid
        for flag, key, cast in (("--alias", "name", str), ("--ctx-size", "ctx", int)):
            if flag in cmd:
                try:
                    info[key] = cast(cmd[cmd.index(flag) + 1])
                except Exception:
                    pass
        break
    if info["running"]:
        # Sleeping frees VRAM, so a small footprint means the weights are out.
        info["asleep"] = gpu()["vramUsedMiB"] < 3000
    return info


def vault() -> dict:
    notes = chunks = 0
    db = VAULT_ROOT / ".agentos" / "index.db"
    if db.exists():
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            notes = con.execute("select count(*) from notes").fetchone()[0]
            chunks = con.execute("select count(*) from chunks").fetchone()[0]
            con.close()
        except Exception:
            pass
    if not notes:
        notes = len(list((VAULT_ROOT / "vault").rglob("*.md")))

    last_backup = "unknown"
    head = VAULT_ROOT / ".git" / "refs" / "heads" / "master"
    if head.exists():
        delta = time.time() - head.stat().st_mtime
        last_backup = (f"{int(delta // 60)} min ago" if delta < 3600
                       else f"{int(delta // 3600)} h ago" if delta < 86400
                       else f"{int(delta // 86400)} d ago")

    journal_today = 0
    today = VAULT_ROOT / "vault" / "journal" / f"{date.today().isoformat()}.md"
    if today.exists():
        journal_today = len(re.findall(r"^\s*-\s+\*\*", today.read_text(encoding="utf-8", errors="ignore"), re.M))
    return {"notes": notes, "chunks": chunks, "lastBackup": last_backup, "journalToday": journal_today}


def games() -> list[str]:
    """Reuse the vault's own game detection so the two never disagree."""
    try:
        sys.path.insert(0, str(VAULT_ROOT))
        from core import gpuguard
        return sorted({name for _, name in gpuguard.running_games()})
    except Exception:
        return []


def snapshot() -> dict:
    now = time.time()
    if _cache["data"] and now - _cache["at"] < CACHE_SECONDS:
        return _cache["data"]

    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disks = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except Exception:
            continue
        disks.append({"mount": part.mountpoint.rstrip("\\"),
                      "usedGB": round(usage.used / 1e9), "totalGB": round(usage.total / 1e9)})

    data = {
        "demo": False,
        "at": datetime.now().isoformat(timespec="seconds"),
        "gpu": gpu(),
        "model": model(),
        "cpu": {
            "name": (psutil.cpu_freq() and f"{psutil.cpu_count(logical=False)}C/{psutil.cpu_count()}T") or "cpu",
            "percent": _live["percent"],
            "perCore": list(_live["perCore"]),
        },
        "memory": {"usedGB": round(mem.used / 1e9, 1), "totalGB": round(mem.total / 1e9, 1),
                   "swapGB": round(swap.used / 1e9, 1)},
        "vault": vault(),
        "disks": disks,
        "net": {"downMbps": _live["downMbps"], "upMbps": _live["upMbps"]},
        "games": games(),
    }
    _cache.update(at=now, data=data)
    return data


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] not in ("/stats", "/"):
            self.send_error(404)
            return
        body = json.dumps(snapshot()).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")   # the page may be served from anywhere local
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):     # quiet: this runs in the background
        pass


if __name__ == "__main__":
    threading.Thread(target=_sample_forever, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"machine stats on http://127.0.0.1:{PORT}/stats  (ctrl+c to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
