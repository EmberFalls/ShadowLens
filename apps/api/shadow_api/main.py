"""FastAPI service shell for local and reverse-proxy ShadowLens deployments."""

from __future__ import annotations

from contextlib import asynccontextmanager
import logging
import time
import uuid
from typing import AsyncIterator, Sequence

from fastapi import APIRouter, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings
from .dependencies import SQLiteAuthStore
from .db.database import initialize_database
from .routers.auth import router as auth_router
from .routers.events import router as events_router
from .routers.analytics import router as analytics_router
from .routers.domains import router as domains_router
from .routers.devices import router as devices_router
from .routers.policy import router as policy_router
from .routers.privacy import router as privacy_router
from .services.policy_signing import get_policy_signer

LOGGER = logging.getLogger("shadowshield.api")
API_PREFIX = "/api/v1"


def _error(request: Request, code: str, message: str, status_code: int) -> JSONResponse:
    request_id = getattr(request.state, "request_id", "unknown")
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "requestId": request_id}},
        headers={"X-Request-ID": request_id},
    )


def create_app(
    settings: Settings | None = None,
    *,
    auth_store=None,
    routers: Sequence[APIRouter] | None = None,
) -> FastAPI:
    """Compose the API shell and product routers under v1.

    Additional routers should declare paths relative to ``/api/v1`` and attach
    ``Depends(require_owner)`` to owner-only routes. This is the registration
    seam so route owners do not need to edit this file or each other's routes.
    """
    runtime_settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        initialize_database(runtime_settings.database_path)
        get_policy_signer(str(runtime_settings.resolved_policy_signing_key_path))
        if app.state.auth_store is None:
            app.state.auth_store = SQLiteAuthStore(runtime_settings.database_path)
        yield

    app = FastAPI(
        title="ShadowShield API",
        version="0.1.0",
        debug=False,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.settings = runtime_settings
    app.state.auth_store = auth_store

    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(runtime_settings.trusted_hosts))
    if runtime_settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(runtime_settings.cors_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["Content-Type", "Authorization", "X-Request-ID"],
            expose_headers=["X-Request-ID"],
            max_age=600,
        )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        started = time.perf_counter()
        is_api_request = request.url.path.startswith(f"{API_PREFIX}/")

        def apply_response_headers(response: Response) -> Response:
            if is_api_request:
                response.headers.setdefault("Cache-Control", "no-store")
                response.headers.setdefault("Pragma", "no-cache")
            response.headers.setdefault("X-Request-ID", request_id)
            response.headers.setdefault("Server-Timing", f"app;dur={(time.perf_counter() - started) * 1000:.1f}")
            return response

        allowed_hosts = set(runtime_settings.trusted_hosts)
        if request.headers.get("host", "") not in allowed_hosts:
            response = _error(request, "INVALID_HOST", "Request host is not allowed.", 400)
            return apply_response_headers(response)
        if runtime_settings.public_origin is not None and request.url.scheme != "https":
            response = _error(request, "TLS_REQUIRED", "Use the configured HTTPS owner service.", 400)
            return apply_response_headers(response)
        try:
            response = await call_next(request)
        except Exception as exc:
            route = getattr(request.scope.get("route"), "path", "/unmatched")
            LOGGER.error(
                "request failed request_id=%s method=%s route=%s error_type=%s",
                request_id,
                request.method,
                route,
                type(exc).__name__,
            )
            response = _error(request, "INTERNAL_ERROR", "The request could not be completed.", 500)
        # Keep timing available to local diagnostics without logging URL or body.
        return apply_response_headers(response)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError):
        del exc
        return _error(request, "INVALID_REQUEST", "Request is invalid.", 422)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        codes = {
            401: ("UNAUTHORIZED", "Authentication required."),
            403: ("FORBIDDEN", "Request is not allowed."),
            429: ("TOO_MANY_REQUESTS", "Too many requests. Try again later."),
            404: ("NOT_FOUND", "Resource not found."),
            405: ("METHOD_NOT_ALLOWED", "Method not allowed."),
            413: ("PAYLOAD_TOO_LARGE", "Request body exceeds the allowed size."),
            422: ("INVALID_REQUEST", "Request is invalid."),
            503: ("SERVICE_UNAVAILABLE", "Service temporarily unavailable."),
        }
        code, message = codes.get(exc.status_code, ("REQUEST_REJECTED", "Request could not be accepted."))
        request_id = getattr(request.state, "request_id", "unknown")
        headers = {"X-Request-ID": request_id, **(exc.headers or {})}
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": code, "message": message, "requestId": request_id}}, headers=headers)

    @app.exception_handler(Exception)
    async def unhandled_error(request: Request, exc: Exception):
        route = getattr(request.scope.get("route"), "path", "/unmatched")
        LOGGER.error(
            "unhandled request request_id=%s method=%s route=%s error_type=%s",
            getattr(request.state, "request_id", "unknown"),
            request.method,
            route,
            type(exc).__name__,
        )
        return _error(request, "INTERNAL_ERROR", "The request could not be completed.", 500)

    @app.get(f"{API_PREFIX}/health", name="health")
    def health() -> dict[str, str]:
        return {"status": "ok", "db": "ready", "contractVersion": "v2"}

    app.include_router(auth_router, prefix=f"{API_PREFIX}/auth", tags=["auth"])
    app.include_router(events_router, prefix=API_PREFIX, tags=["events"])
    # The production composition registers every owner-facing router by default.
    # Tests may pass an explicit router list to keep route isolation intentional.
    active_routers = routers if routers is not None else (
        analytics_router, domains_router, devices_router, policy_router, privacy_router,
    )
    for router in active_routers:
        app.include_router(router, prefix=API_PREFIX)

    dashboard = runtime_settings.dashboard_dist
    if dashboard.is_dir():
        app.mount("/", StaticFiles(directory=dashboard, html=True, check_dir=True), name="dashboard")

    return app


app = create_app()


def run() -> None:
    import uvicorn

    settings = Settings.from_env()
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        reload=False,
        access_log=False,
        log_level="info",
        proxy_headers=settings.public_origin is not None,
        forwarded_allow_ips=settings.forwarded_allow_ips,
    )


if __name__ == "__main__":
    run()
