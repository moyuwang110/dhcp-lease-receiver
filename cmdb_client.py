"""veops CMDB API 客户端(按官方文档实现鉴权与增删改查)。

鉴权:_secret = sha1(url_path + secret + 按参数名排序拼接的参数值) 的十六进制值,
     _key 与 _secret 随请求参数一起提交。
"""
from __future__ import annotations

import hashlib
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import requests

BASE_URL = "http://cmdb.example.com:8000"
API_KEY = "<YOUR_CMDB_API_KEY>"
API_SECRET = "<YOUR_CMDB_API_SECRET>"

_TIMEOUT = 15


def build_api_key(path: str, params: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """按官方文档生成签名参数。"""
    params = dict(params or {})
    values = "".join(
        str(params[k])
        for k in sorted(params.keys())
        if k not in ("_key", "_secret") and not isinstance(params[k], (dict, list))
    )
    raw = "".join([path, API_SECRET, values]).encode("utf-8")
    params["_secret"] = hashlib.sha1(raw).hexdigest()
    params["_key"] = API_KEY
    return params


def _handle(resp: requests.Response) -> Dict[str, Any]:
    try:
        data = resp.json()
    except ValueError:
        data = {"message": resp.text[:500]}
    data["_http_status"] = resp.status_code
    return data


def get(path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = BASE_URL + path
    p = build_api_key(urlparse(url).path, params)
    return _handle(requests.get(url, params=p, timeout=_TIMEOUT))


def post(path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = BASE_URL + path
    p = build_api_key(urlparse(url).path, payload)
    return _handle(requests.post(url, json=p, timeout=_TIMEOUT))


def put(path: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = BASE_URL + path
    p = build_api_key(urlparse(url).path, payload)
    return _handle(requests.put(url, json=p, timeout=_TIMEOUT))


def delete(path: str) -> Dict[str, Any]:
    url = BASE_URL + path
    p = build_api_key(urlparse(url).path, {})
    return _handle(requests.delete(url, json=p, timeout=_TIMEOUT))


# ---------------------------------------------------------------------------
# 高层操作
# ---------------------------------------------------------------------------


def search_ci(q: str, fl: str = "", count: int = 25, page: int = 1) -> Dict[str, Any]:
    params: Dict[str, Any] = {"q": q, "count": count, "page": page}
    if fl:
        params["fl"] = fl
    return get("/api/v0.1/ci/s", params)


def upsert_ci(ci_type: str, attributes: Dict[str, Any], exist_policy: str = "replace") -> Dict[str, Any]:
    """创建或覆盖 CI(exist_policy=replace 时按唯一键替换)。"""
    payload = {"ci_type": ci_type, "exist_policy": exist_policy}
    payload.update(attributes)
    return post("/api/v0.1/ci", payload)


def delete_ci(ci_id: int) -> Dict[str, Any]:
    return delete(f"/api/v0.1/ci/{ci_id}")