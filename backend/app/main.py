from __future__ import annotations

import logging
import os
import time
from typing import Annotated

import httpx
from fastapi import (
    Cookie,
    Depends,
    FastAPI,
    File,
    HTTPException,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import JSONResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel

logger = logging.getLogger("eneo_proxy")
logging.basicConfig(level=logging.INFO)


# ---------- Settings ----------

class SpaceConfig(BaseModel):
    id: str
    api_key: str
    name: str | None = None


class Settings(BaseModel):
    eneo_api_base: str
    eneo_api_key: str  # primär nyckel; används som fallback om X-Space-Id saknas/inte matchar
    app_access_code: str
    session_secret: str
    cookie_secure: bool = False
    demo_space_id: str | None = None  # bakåtkomp — speglar spaces[0].id
    demo_space_name: str | None = None  # bakåtkomp — speglar spaces[0].name
    upload_proxy_timeout_seconds: float = 1800.0
    spaces: list[SpaceConfig] = []


def _parse_bool(raw: str | None, default: bool = False) -> bool:
    if raw is None:
        return default
    return raw.strip().lower() in {"true", "1", "yes", "on"}


def load_settings() -> Settings:
    required = ["ENEO_API_BASE", "ENEO_API_KEY", "APP_ACCESS_CODE", "SESSION_SECRET"]
    missing = [k for k in required if not os.getenv(k)]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")
    if len(os.environ["APP_ACCESS_CODE"]) < 4:
        raise RuntimeError("APP_ACCESS_CODE must be at least 4 characters")
    if len(os.environ["SESSION_SECRET"]) < 32:
        raise RuntimeError("SESSION_SECRET must be at least 32 characters")

    primary_key = os.environ["ENEO_API_KEY"]
    primary_space_id = os.environ.get("DEMO_SPACE_ID") or None
    primary_space_name = os.environ.get("DEMO_SPACE_NAME") or None

    spaces: list[SpaceConfig] = []
    if primary_space_id:
        spaces.append(
            SpaceConfig(id=primary_space_id, api_key=primary_key, name=primary_space_name)
        )

    second_key = os.environ.get("ENEO_API_KEY_2") or None
    second_space_id = os.environ.get("DEMO_SPACE_ID_2") or None
    second_space_name = os.environ.get("DEMO_SPACE_NAME_2") or None
    if second_key and second_space_id:
        spaces.append(
            SpaceConfig(id=second_space_id, api_key=second_key, name=second_space_name)
        )
    elif second_key or second_space_id:
        logger.warning(
            "ENEO_API_KEY_2 and DEMO_SPACE_ID_2 must both be set to enable the second space; ignoring partial config."
        )

    return Settings(
        eneo_api_base=os.environ["ENEO_API_BASE"].rstrip("/"),
        eneo_api_key=primary_key,
        app_access_code=os.environ["APP_ACCESS_CODE"],
        session_secret=os.environ["SESSION_SECRET"],
        cookie_secure=_parse_bool(os.environ.get("COOKIE_SECURE"), default=False),
        demo_space_id=primary_space_id,
        demo_space_name=primary_space_name,
        upload_proxy_timeout_seconds=float(
            os.environ.get("UPLOAD_PROXY_TIMEOUT_SECONDS", "1800")
        ),
        spaces=spaces,
    )


def _key_for_space(space_id: str | None) -> str:
    """Slå upp matching API-key för ett space-id. Faller tillbaka till primär nyckel."""
    if space_id:
        for s in settings.spaces:
            if s.id == space_id:
                return s.api_key
    return settings.eneo_api_key


settings = load_settings()

SESSION_COOKIE = "eneo_demo_session"
SESSION_MAX_AGE = 8 * 60 * 60  # 8 hours
SESSION_NAMESPACE = "eneo-demo-session"
MIN_UPLOAD_PROXY_TIMEOUT_SECONDS = 60.0

serializer = URLSafeTimedSerializer(settings.session_secret, salt=SESSION_NAMESPACE)


# ---------- App ----------

app = FastAPI(title="Eneo Flows Demo Backend")
http_client = httpx.AsyncClient(
    timeout=httpx.Timeout(60.0, connect=10.0),
    follow_redirects=True,
)


def _upload_timeout(timeout_seconds: float | None = None) -> httpx.Timeout:
    effective_timeout = settings.upload_proxy_timeout_seconds
    if timeout_seconds is not None:
        effective_timeout = min(
            settings.upload_proxy_timeout_seconds,
            max(MIN_UPLOAD_PROXY_TIMEOUT_SECONDS, timeout_seconds),
        )
    return httpx.Timeout(
        connect=10.0,
        read=effective_timeout,
        write=effective_timeout,
        pool=30.0,
    )


def _requested_upload_timeout_seconds(request: Request) -> float | None:
    raw = request.headers.get("x-upload-timeout-seconds")
    if raw is None:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value > 0 else None


@app.on_event("shutdown")
async def _shutdown() -> None:
    await http_client.aclose()


@app.get("/api/healthz")
async def healthz():
    return {"ok": True}


@app.get("/api/config")
async def get_config():
    return {
        "demo_space_id": settings.demo_space_id,
        "demo_space_name": settings.demo_space_name,
        "demo_space_ids": [s.id for s in settings.spaces],
    }


# ---------- Auth ----------

class LoginRequest(BaseModel):
    access_code: str


def _make_session_token() -> str:
    return serializer.dumps({"iat": int(time.time())})


def _is_valid_session(token: str | None) -> bool:
    if not token:
        return False
    try:
        serializer.loads(token, max_age=SESSION_MAX_AGE)
        return True
    except (BadSignature, SignatureExpired):
        return False


def require_auth(
    eneo_demo_session: Annotated[str | None, Cookie()] = None,
) -> None:
    if not _is_valid_session(eneo_demo_session):
        # Headern särskiljer VÅR 401 (kräver omlogg) från en upstream-401 som
        # Eneo råkar svara med (ogiltig nyckel etc). Frontend redirectar
        # bara om denna header finns; annars visas felet i UI:t i stället
        # för att skicka användaren till login-loopen.
        raise HTTPException(
            status_code=401,
            detail="Not authenticated",
            headers={"X-Auth-Required": "session"},
        )


@app.post("/api/auth/login")
async def login(body: LoginRequest, response: Response):
    if body.access_code != settings.app_access_code:
        raise HTTPException(status_code=401, detail="Invalid access code")
    token = _make_session_token()
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        max_age=SESSION_MAX_AGE,
        path="/",
    )
    return {"ok": True}


@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/auth/status")
async def auth_status(
    eneo_demo_session: Annotated[str | None, Cookie()] = None,
):
    return {"authenticated": _is_valid_session(eneo_demo_session)}


# ---------- Eneo proxy ----------

# Headers we should not forward from incoming request to upstream.
_HOP_BY_HOP_REQUEST_HEADERS = {
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "cookie",
    "x-api-key",
    # Intern routing-header — Eneo ska inte se den.
    "x-space-id",
    # Intern proxy-budget för stora uploads.
    "x-upload-timeout-seconds",
}

# Headers we should not forward from upstream response back to client.
_HOP_BY_HOP_RESPONSE_HEADERS = {
    "content-encoding",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "content-length",
}


# Dedicated upload routes — bypass the catch-all proxy because forwarding
# the browser's raw multipart bytes triggers ReadError from Eneo's load balancer.
# We re-parse and rebuild the multipart with httpx instead.
async def _proxy_multipart_upload(
    upstream_url: str,
    upload_file: UploadFile,
    space_id: str | None = None,
    timeout_seconds: float | None = None,
) -> Response:
    api_key = _key_for_space(space_id)
    await upload_file.seek(0)
    # Eneo validerar den DEKLARERADE mimetypen mot stegets accepted_mimetypes och
    # avvisar generiska typer (415 unsupported_media_type). Skicka därför vidare
    # exakt det browsern deklarerade i multipart-delen, utan egen fallback.
    content_type = upload_file.content_type or None
    file_spec: tuple = (
        (upload_file.filename, upload_file.file, content_type)
        if content_type
        else (upload_file.filename, upload_file.file)
    )
    try:
        upstream = await http_client.post(
            upstream_url,
            headers={"X-API-Key": api_key},
            files={"upload_file": file_spec},
            timeout=_upload_timeout(timeout_seconds),
        )
    except httpx.TimeoutException as exc:
        logger.exception("Upload timed out: url=%s", upstream_url)
        return JSONResponse(
            status_code=504,
            content={
                "error": "upstream_upload_timeout",
                "detail": f"{type(exc).__name__}: {exc}",
            },
        )
    except httpx.RequestError as exc:
        logger.exception("Upload failed: url=%s", upstream_url)
        return JSONResponse(
            status_code=502,
            content={
                "error": "upstream_unreachable",
                "detail": f"{type(exc).__name__}: {exc}",
            },
        )

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )


@app.post(
    "/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files",
    dependencies=[Depends(require_auth)],
)
@app.post(
    "/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files/",
    dependencies=[Depends(require_auth)],
)
async def eneo_upload_step_runtime_file(
    flow_id: str,
    step_id: str,
    request: Request,
    upload_file: UploadFile = File(...),
) -> Response:
    upstream_url = (
        f"{settings.eneo_api_base}/api/v1/flows/{flow_id}"
        f"/steps/{step_id}/runtime-files/"
    )
    space_id = request.headers.get("x-space-id")
    return await _proxy_multipart_upload(
        upstream_url,
        upload_file,
        space_id,
        _requested_upload_timeout_seconds(request),
    )


@app.api_route(
    "/api/eneo/{path:path}",
    methods=["GET", "POST", "PATCH", "PUT", "DELETE"],
    dependencies=[Depends(require_auth)],
)
async def eneo_proxy(path: str, request: Request) -> Response:
    upstream_url = f"{settings.eneo_api_base}/api/v1/{path}"

    # Välj nyckel baserat på X-Space-Id-routing header (om frontend skickat).
    space_id = request.headers.get("x-space-id")
    api_key = _key_for_space(space_id)

    # Forward request headers, but strip hop-by-hop and inject API key.
    fwd_headers: dict[str, str] = {}
    for name, value in request.headers.items():
        if name.lower() in _HOP_BY_HOP_REQUEST_HEADERS:
            continue
        fwd_headers[name] = value
    fwd_headers["X-API-Key"] = api_key

    body = await request.body()

    try:
        upstream = await http_client.request(
            method=request.method,
            url=upstream_url,
            params=request.query_params,
            content=body if body else None,
            headers=fwd_headers,
        )
    except httpx.RequestError as exc:
        logger.exception(
            "Upstream request failed: method=%s url=%s",
            request.method,
            upstream_url,
        )
        return JSONResponse(
            status_code=502,
            content={
                "error": "upstream_unreachable",
                "detail": f"{type(exc).__name__}: {exc}",
            },
        )

    resp_headers = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() not in _HOP_BY_HOP_RESPONSE_HEADERS
    }

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=upstream.headers.get("content-type"),
    )
