#!/usr/bin/env python3
"""Stdio MCP entrypoint for XMCP in Antigravity plugins.

Wraps the official X API v2 OpenAPI specification with FastMCP over stdio:
- Keeps stdout strictly clean for MCP JSON-RPC frames (all logs go to stderr).
- Caches OAuth 1.0a user tokens in ~/.config/x-articles/oauth1_tokens.json (0600)
  so browser OAuth consent only opens on first setup (or when revoked/expired).
- Provides two zero-token-overhead composite tools (`uploadLocalMedia` and
  `createArticleDraftFromJsonFile`) so agents never have to stream multi-megabyte
  base64 images or re-emit deterministic `content_state` JSON through LLM tokens.
"""

import asyncio
import base64
import contextlib
import copy
import hashlib
import http.server
import inspect
import json
import logging
import mimetypes
import os
import socketserver
import sys
import threading
import time
import urllib.parse
import webbrowser
from pathlib import Path

import httpx
import requests
from fastmcp import FastMCP
from oauthlib.oauth1 import Client as OAuth1Client
from requests_oauthlib import OAuth1Session

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="[x-articles-xmcp] %(levelname)s %(message)s",
)
LOGGER = logging.getLogger("xmcp.stdio")

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "options", "head", "trace"}
REQUEST_TOKEN_URL = "https://api.x.com/oauth/request_token"
AUTHORIZE_URL = "https://api.x.com/oauth/authorize"
ACCESS_TOKEN_URL = "https://api.x.com/oauth/access_token"
DEFAULT_ALLOWLIST = (
    "articleCreateDraft,articlePublish,"
    "initializeMediaUpload,appendMediaUpload,finalizeMediaUpload,getMediaUploadStatus"
)


def parse_csv(raw: str) -> set[str]:
    return {item.strip() for item in raw.split(",") if item.strip()}


def token_cache_path() -> Path:
    xdg = os.getenv("XDG_CONFIG_HOME", "").strip()
    base = Path(xdg) if xdg else (Path.home() / ".config")
    return base / "x-articles" / "oauth1_tokens.json"


def load_cached_tokens(key_id: str) -> tuple[str, str] | None:
    path = token_cache_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        entry = data.get(key_id)
        if isinstance(entry, dict):
            tok = entry.get("access_token")
            sec = entry.get("access_secret")
            if isinstance(tok, str) and tok and isinstance(sec, str) and sec:
                return tok, sec
    except Exception as exc:
        LOGGER.warning("Ignoring unreadable OAuth cache (%s)", exc)
    return None


def save_cached_tokens(key_id: str, access_token: str, access_secret: str) -> None:
    path = token_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    data: dict = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}
    data[key_id] = {
        "access_token": access_token,
        "access_secret": access_secret,
        "saved_at": int(time.time()),
    }
    tmp = path.with_suffix(".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(str(tmp), str(path))


def wait_for_callback(host: str, port: int, path: str, timeout_seconds: int) -> tuple[str, str]:
    params: dict[str, str | None] = {"oauth_token": None, "oauth_verifier": None}
    event = threading.Event()

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != path:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not found.")
                return
            query = urllib.parse.parse_qs(parsed.query)
            params["oauth_token"] = (query.get("oauth_token") or [None])[0]
            params["oauth_verifier"] = (query.get("oauth_verifier") or [None])[0]
            event.set()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"<html><body style='font-family:system-ui;padding:2rem'>"
                b"<h2>X Articles OAuth complete</h2>"
                b"<p>You may close this tab and return to Antigravity.</p>"
                b"</body></html>"
            )

        def log_message(self, fmt: str, *args: object) -> None:
            LOGGER.debug("OAuth callback: " + fmt, *args)

    class _Server(socketserver.TCPServer):
        allow_reuse_address = True

    server = _Server((host, port), _Handler)
    server.timeout = 1
    deadline = time.time() + timeout_seconds
    try:
        while time.time() < deadline:
            server.handle_request()
            if event.is_set():
                break
    finally:
        server.server_close()

    oauth_token = params.get("oauth_token")
    oauth_verifier = params.get("oauth_verifier")
    if not oauth_token or not oauth_verifier:
        raise TimeoutError("OAuth callback not received before timeout.")
    return oauth_token, oauth_verifier


def run_oauth1_flow(consumer_key: str, consumer_secret: str) -> tuple[str, str]:
    host = os.getenv("X_OAUTH_CALLBACK_HOST", "127.0.0.1")
    port = int(os.getenv("X_OAUTH_CALLBACK_PORT", "8976") or "8976")
    path = os.getenv("X_OAUTH_CALLBACK_PATH", "/oauth/callback")
    timeout = int(os.getenv("X_OAUTH_CALLBACK_TIMEOUT", "300") or "300")
    callback_url = f"http://{host}:{port}{path}"

    oauth = OAuth1Session(
        client_key=consumer_key,
        client_secret=consumer_secret,
        callback_uri=callback_url,
    )
    req_tok = oauth.fetch_request_token(REQUEST_TOKEN_URL)
    ro_key = req_tok.get("oauth_token")
    ro_secret = req_tok.get("oauth_token_secret")
    if not ro_key or not ro_secret:
        raise RuntimeError("Failed to obtain X OAuth request token.")

    auth_url = oauth.authorization_url(AUTHORIZE_URL)
    LOGGER.info("Opening browser for X OAuth1 consent (callback %s)", callback_url)
    webbrowser.open(auth_url)

    cb_tok, verifier = wait_for_callback(host, port, path, timeout)
    if cb_tok != ro_key:
        raise RuntimeError("OAuth callback token mismatch.")

    oauth = OAuth1Session(
        client_key=consumer_key,
        client_secret=consumer_secret,
        resource_owner_key=ro_key,
        resource_owner_secret=ro_secret,
        verifier=verifier,
    )
    acc = oauth.fetch_access_token(ACCESS_TOKEN_URL)
    acc_key = acc.get("oauth_token")
    acc_sec = acc.get("oauth_token_secret")
    if not acc_key or not acc_sec:
        raise RuntimeError("Failed to exchange X OAuth access token.")
    return acc_key, acc_sec


def token_is_valid(client: OAuth1Client, base_url: str) -> bool:
    probe_url = f"{base_url}/2/users/me"
    signed_url, signed_headers, _ = client.sign(probe_url, http_method="GET", headers={})
    try:
        resp = requests.get(signed_url, headers=signed_headers, timeout=10)
        return resp.status_code != 401
    except Exception:
        return True


def get_oauth1_client(base_url: str) -> OAuth1Client:
    consumer_key = os.getenv("X_OAUTH_CONSUMER_KEY", "").strip()
    consumer_secret = os.getenv("X_OAUTH_CONSUMER_SECRET", "").strip()
    if not consumer_key or not consumer_secret or consumer_key.startswith("${"):
        raise RuntimeError(
            "Missing X_OAUTH_CONSUMER_KEY or X_OAUTH_CONSUMER_SECRET. "
            "Fill them in on the x-articles plugin page in Antigravity."
        )

    env_acc_tok = os.getenv("X_OAUTH_ACCESS_TOKEN", "").strip()
    env_acc_sec = os.getenv("X_OAUTH_ACCESS_TOKEN_SECRET", "").strip()
    if env_acc_tok and env_acc_sec:
        return OAuth1Client(
            client_key=consumer_key,
            client_secret=consumer_secret,
            resource_owner_key=env_acc_tok,
            resource_owner_secret=env_acc_sec,
            signature_type="AUTH_HEADER",
        )

    key_id = hashlib.sha256(consumer_key.encode("utf-8")).hexdigest()[:16]
    cached = load_cached_tokens(key_id)
    if cached:
        client = OAuth1Client(
            client_key=consumer_key,
            client_secret=consumer_secret,
            resource_owner_key=cached[0],
            resource_owner_secret=cached[1],
            signature_type="AUTH_HEADER",
        )
        if token_is_valid(client, base_url):
            LOGGER.info("Using cached OAuth1 user token for consumer key %s...", key_id[:8])
            return client
        LOGGER.info("Cached OAuth1 token returned 401; re-running browser OAuth consent.")

    acc_tok, acc_sec = run_oauth1_flow(consumer_key, consumer_secret)
    save_cached_tokens(key_id, acc_tok, acc_sec)
    return OAuth1Client(
        client_key=consumer_key,
        client_secret=consumer_secret,
        resource_owner_key=acc_tok,
        resource_owner_secret=acc_sec,
        signature_type="AUTH_HEADER",
    )


def should_join_query_param(param: dict) -> bool:
    if param.get("in") != "query":
        return False
    if param.get("schema", {}).get("type") != "array":
        return False
    return param.get("explode") is False


def collect_comma_params(spec: dict) -> set[str]:
    comma_params: set[str] = set()
    for param in spec.get("components", {}).get("parameters", {}).values():
        if isinstance(param, dict) and should_join_query_param(param):
            if isinstance(param.get("name"), str):
                comma_params.add(param["name"])
    for item in spec.get("paths", {}).values():
        if not isinstance(item, dict):
            continue
        for method, operation in item.items():
            if method.lower() not in HTTP_METHODS or not isinstance(operation, dict):
                continue
            for param in operation.get("parameters", []):
                if isinstance(param, dict) and "$ref" not in param and should_join_query_param(param):
                    if isinstance(param.get("name"), str):
                        comma_params.add(param["name"])
    return comma_params


def filter_openapi_spec(spec: dict, allow_ops: set[str]) -> dict:
    filtered = copy.deepcopy(spec)
    new_paths = {}
    for path, item in filtered.get("paths", {}).items():
        if not isinstance(item, dict) or "/webhooks" in path or "/stream" in path:
            continue
        new_item = {}
        for key, value in item.items():
            if key.lower() in HTTP_METHODS and isinstance(value, dict):
                tags = {t.lower() for t in value.get("tags", []) if isinstance(t, str)}
                if "stream" in tags or "webhooks" in tags or value.get("x-twitter-streaming") is True:
                    continue
                op_id = value.get("operationId")
                if allow_ops and op_id not in allow_ops:
                    continue
                new_item[key] = value
            else:
                new_item[key] = value
        if any(m.lower() in HTTP_METHODS for m in new_item):
            new_paths[path] = new_item
    filtered["paths"] = new_paths
    return filtered


def unwrap_tool_result(res: object) -> dict:
    sc = getattr(res, "structured_content", None)
    if isinstance(sc, dict):
        return sc
    content = getattr(res, "content", None)
    if content:
        txt = getattr(content[0], "text", "")
        if isinstance(txt, str) and txt.strip():
            try:
                return json.loads(txt)
            except Exception:
                return {"raw": txt}
    return {}


def guess_media_type(path: Path) -> str:
    ext = path.suffix.lower()
    mapping = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
    }
    if ext in mapping:
        return mapping[ext]
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "image/png"


def build_mcp() -> FastMCP:
    base_url = os.getenv("X_API_BASE_URL", "https://api.x.com")
    timeout = float(os.getenv("X_API_TIMEOUT", "60") or "60")
    allow_raw = os.getenv("X_API_TOOL_ALLOWLIST", DEFAULT_ALLOWLIST)
    allow_ops = parse_csv(allow_raw)

    oauth1_client = get_oauth1_client(base_url)

    spec_resp = requests.get("https://api.x.com/2/openapi.json", timeout=30)
    spec_resp.raise_for_status()
    filtered_spec = filter_openapi_spec(spec_resp.json(), allow_ops)
    comma_params = collect_comma_params(filtered_spec)

    async def normalize_query_params(request: httpx.Request) -> None:
        if not comma_params:
            return
        params = list(request.url.params.multi_items())
        grouped: dict[str, list[str]] = {}
        ordered: list[str] = []
        normalized: list[tuple[str, str]] = []
        for k, v in params:
            if k in comma_params:
                if k not in grouped:
                    ordered.append(k)
                grouped.setdefault(k, []).append(v)
            else:
                normalized.append((k, v))
        if not grouped:
            return
        for k in ordered:
            vals: list[str] = []
            for raw in grouped[k]:
                for part in raw.split(","):
                    part = part.strip()
                    if part and part not in vals:
                        vals.append(part)
            if vals:
                normalized.append((k, ",".join(vals)))
        request.url = request.url.copy_with(params=normalized)

    b3_flags = os.getenv("X_B3_FLAGS", "1")

    async def sign_oauth1_request(request: httpx.Request) -> None:
        request.headers["X-B3-Flags"] = b3_flags
        headers = dict(request.headers)
        body: str | None = None
        if headers.get("Content-Type", "").startswith("application/x-www-form-urlencoded"):
            body = (request.content or b"").decode("utf-8")
        signed_url, signed_headers, _ = oauth1_client.sign(
            str(request.url),
            http_method=request.method,
            body=body,
            headers=headers,
        )
        request.url = httpx.URL(signed_url)
        request.headers.update(signed_headers)

    client = httpx.AsyncClient(
        base_url=base_url,
        timeout=timeout,
        event_hooks={"request": [normalize_query_params, sign_oauth1_request]},
    )
    mcp = FastMCP.from_openapi(openapi_spec=filtered_spec, client=client, name="X Articles XMCP")

    @mcp.tool()
    async def uploadLocalMedia(
        file_path: str,
        media_category: str = "tweet_image",
        media_type: str = "",
        pre_initialized_id: str = "",
    ) -> dict:
        """Upload a local image/video file from disk via X chunked media upload (initialize -> append -> finalize -> status poll) without passing base64 bytes through LLM context."""
        p = Path(file_path).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"Media file not found: {p}")
        raw_bytes = p.read_bytes()
        resolved_type = media_type.strip() or guess_media_type(p)

        if pre_initialized_id.strip():
            media_id = pre_initialized_id.strip()
        else:
            init_res = unwrap_tool_result(
                await mcp.call_tool(
                    "initializeMediaUpload",
                    {
                        "media_category": media_category,
                        "media_type": resolved_type,
                        "total_bytes": len(raw_bytes),
                    },
                )
            )
            media_id = str((init_res.get("data") or init_res).get("id") or "")
            if not media_id:
                raise RuntimeError(f"initializeMediaUpload returned no media id: {init_res}")

        chunk_size = 2_500_000
        seg_idx = 0
        for offset in range(0, len(raw_bytes), chunk_size):
            chunk = raw_bytes[offset : offset + chunk_size]
            b64 = base64.b64encode(chunk).decode("ascii")
            await mcp.call_tool(
                "appendMediaUpload",
                {
                    "id": media_id,
                    "media": b64,
                    "segment_index": seg_idx,
                },
            )
            seg_idx += 1

        fin_res = unwrap_tool_result(await mcp.call_tool("finalizeMediaUpload", {"id": media_id}))
        fin_data = fin_res.get("data") or fin_res
        proc = fin_data.get("processing_info") if isinstance(fin_data, dict) else None
        while isinstance(proc, dict) and proc.get("state") in ("pending", "in_progress"):
            wait_s = int(proc.get("check_after_secs") or 2)
            await asyncio.sleep(wait_s)
            st_res = unwrap_tool_result(
                await mcp.call_tool("getMediaUploadStatus", {"media_id": media_id})
            )
            st_data = st_res.get("data") or st_res
            proc = st_data.get("processing_info") if isinstance(st_data, dict) else None
        if isinstance(proc, dict) and proc.get("state") == "failed":
            raise RuntimeError(f"X media processing failed for {p.name}: {proc}")

        return {
            "media_id": media_id,
            "media_category": media_category,
            "bytes": len(raw_bytes),
            "file": str(p),
        }

    @mcp.tool()
    async def createArticleDraftFromJsonFile(
        draft_json_path: str,
        cover_media_id: str = "",
        cover_media_category: str = "tweet_image",
    ) -> dict:
        """Create an X Article draft directly from a converter-generated draft.json file on disk so deterministic content_state JSON is never re-serialized by the LLM."""
        p = Path(draft_json_path).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"Draft JSON file not found: {p}")
        doc = json.loads(p.read_text(encoding="utf-8"))
        payload: dict = {
            "title": doc["title"],
            "content_state": doc["content_state"],
        }
        if cover_media_id.strip():
            payload["cover_media"] = {
                "media_category": cover_media_category,
                "media_id": cover_media_id.strip(),
            }
        res = unwrap_tool_result(await mcp.call_tool("articleCreateDraft", payload))
        data = res.get("data") if isinstance(res, dict) else None
        article_id = str((data or res).get("id") or "") if isinstance((data or res), dict) else ""
        return {
            "article_id": article_id,
            "editor_url": f"https://x.com/compose/articles/edit/{article_id}" if article_id else "",
            "response": res,
        }

    return mcp


def main() -> None:
    with contextlib.redirect_stdout(sys.stderr):
        mcp = build_mcp()
    sig = inspect.signature(mcp.run)
    kwargs: dict = {"transport": "stdio"}
    if "show_banner" in sig.parameters:
        kwargs["show_banner"] = False
    mcp.run(**kwargs)


if __name__ == "__main__":
    main()
