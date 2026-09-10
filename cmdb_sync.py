"""将接收端最新 DHCP 租约同步到 veops CMDB 的"DHCP信息"模块。

- 唯一键 MAC_ID(统一格式 0088-6536-1e4a),exist_policy=replace 自动去重更新
- 每天定时任务推送数据后由 app.py 自动触发,也可命令行手动执行:
    python3 cmdb_sync.py            # 同步所有服务器
    python3 cmdb_sync.py DC01       # 同步指定服务器
"""
from __future__ import annotations

import json
import logging
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cmdb_client

logger = logging.getLogger("cmdb-sync")

DATA_DIR = Path(__file__).resolve().parent / "data"
CI_TYPE = "DHCP信息"
WORKERS = 8

_MAC12_RE = re.compile(r"^[0-9a-f]{12}$")

NAMEMAP_PATH = DATA_DIR / "namemap.json"


def _norm_key(s: str) -> str:
    return (s or "").strip().lower()


def _mac_canonical(s: str) -> str:
    """MAC 的比较形态:去分隔符、小写。"""
    return re.sub(r"[-:.\s]", "", (s or "")).lower()


def _load_namemap() -> Dict[str, str]:
    """姓名映射表:键(主机名/IP/MAC,小写) -> 姓名。"""
    if not NAMEMAP_PATH.exists():
        return {}
    try:
        data = json.loads(NAMEMAP_PATH.read_text(encoding="utf-8"))
        return {str(k).strip().lower(): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _match_name(lease: dict, namemap: Dict[str, str]) -> str:
    """按 主机名 -> IP -> MAC 顺序匹配姓名,两侧均做归一化对齐。"""
    hn = (lease.get("HostName") or "").strip()
    hn_candidates = [_norm_key(hn)] if hn else []
    if "." in hn:
        hn_candidates.append(_norm_key(hn.split(".")[0]))
    for c in hn_candidates:
        if c and c in namemap:
            return namemap[c]

    ip = _norm_key(lease.get("IPAddress"))
    if ip and ip in namemap:
        return namemap[ip]

    mac = lease.get("ClientId") or ""
    cmac = _mac_canonical(mac)
    if len(cmac) == 12:
        if cmac in namemap:
            return namemap[cmac]
        for k, v in namemap.items():
            if _mac_canonical(k) == cmac:
                return v
    return ""


def _format_mac(client_id: str) -> str:
    """MAC 归一化为 0088-6536-1e4a 形式;非标准 MAC 原样返回。"""
    raw = (client_id or "").strip()
    s = re.sub(r"[-:.\s]", "", raw).lower()
    if _MAC12_RE.match(s):
        return "-".join(s[i:i + 4] for i in (0, 4, 8))
    return raw


def _short_lease(s: str) -> str:
    """租期只保留日期:2026-09-11 09:00:00 -> 2026-09-11。"""
    raw = (s or "").strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", raw)
    return m.group(1) if m else raw


def _load_latest(server_id: str) -> Optional[dict]:
    path = DATA_DIR / server_id / "latest.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        logger.error("读取 %s 失败: %s", path, exc)
        return None


def _prepare(snapshot: dict, namemap: Dict[str, str]) -> Tuple[List[Dict[str, str]], int, int]:
    """把租约转换为 CMDB 属性字典列表,返回 (rows, skipped, named)。

    - 同一 MAC 多个 IP 时按文件顺序保留最后一条(确定性去重)
    - 有姓名映射的记录附带 HDCP_name;无映射不提交该字段,保留 CMDB 原值
    """
    rows: List[Dict[str, str]] = []
    skipped = 0
    named = 0
    by_mac: Dict[str, Dict[str, str]] = {}
    for item in snapshot.get("leases") or []:
        mac = _format_mac(item.get("ClientId"))
        ip = (item.get("IPAddress") or "").strip()
        if not mac or not ip:
            skipped += 1  # 缺唯一键或必填 IP,无法入库
            continue
        row = {
            "MAC_ID": mac,
            "DHCP_IPAddress": ip,
            "HostName": (item.get("HostName") or "").strip(),
            "AddressState": (item.get("AddressState") or "").strip(),
            "LeaseExpiryTime": _short_lease(item.get("LeaseExpiryTime")),
        }
        name = _match_name(item, namemap)
        if name:
            row["HDCP_name"] = name
            named += 1
        by_mac[mac] = row
    rows = list(by_mac.values())
    return rows, skipped, named


def _upsert_one(row: Dict[str, str]) -> Tuple[bool, str]:
    try:
        r = cmdb_client.upsert_ci(CI_TYPE, row, exist_policy="replace")
        if r.get("_http_status") == 200 and r.get("ci_id"):
            return True, ""
        return False, str(r.get("message") or r)[:200]
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


def sync_server(server_id: str) -> Dict[str, Any]:
    """同步单个服务器的最新租约到 CMDB,返回结果统计。"""
    t0 = time.time()
    snapshot = _load_latest(server_id)
    if snapshot is None:
        return {"server": server_id, "status": "no_data"}

    namemap = _load_namemap()
    rows, skipped, named = _prepare(snapshot, namemap)
    ok = failed = 0
    errors: List[str] = []

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(_upsert_one, row): row for row in rows}
        for fut in as_completed(futures):
            success, err = fut.result()
            if success:
                ok += 1
            else:
                failed += 1
                if len(errors) < 5:
                    errors.append(f"{futures[fut].get('MAC_ID')}: {err}")

    result = {
        "server": server_id,
        "status": "ok",
        "collectedAt": snapshot.get("collectedAt"),
        "total": len(rows),
        "ok": ok,
        "failed": failed,
        "skipped": skipped,
        "withName": named,
        "elapsed": round(time.time() - t0, 1),
    }
    if errors:
        result["errors"] = errors
    logger.info("CMDB 同步 %s: 成功 %d / 失败 %d / 跳过 %d", server_id, ok, failed, skipped)
    return result


def sync_all() -> Dict[str, Any]:
    """同步所有已推送数据的服务器。"""
    servers = []
    if DATA_DIR.exists():
        for d in sorted(DATA_DIR.iterdir()):
            if d.is_dir() and not d.name.startswith(".") and (d / "latest.json").exists():
                servers.append(d.name)
    results = {sid: sync_server(sid) for sid in servers}
    return {"status": "ok", "results": results}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    target = sys.argv[1] if len(sys.argv) > 1 else None
    out = sync_server(target) if target else sync_all()
    print(json.dumps(out, ensure_ascii=False, indent=2))