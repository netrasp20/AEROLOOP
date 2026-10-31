"""Uvicorn entrypoint. Mirrors server.ts: loads config, binds on PORT (default 5000)
and serves the combined FastAPI + Socket.IO ASGI app.

Run this file (``python3 main.py``) for development. Do NOT point uvicorn at
``app:app`` — that is the bare FastAPI router, which serves every ``/api/*``
route but 404s ``/socket.io/``, so the UI silently shows "Disconnected" while
the vehicle is actually connected. The Socket.IO server is attached by
``app.asgi_app`` (see ``sio/server.py``); ``app:app`` skips that step.
"""

import logging

from core import config

logging.basicConfig(level=logging.INFO)

if __name__ == "__main__":
    import uvicorn

    # Guard against the footgun documented above: both are importable, so
    # importing this module must not silently drop the Socket.IO mount.
    from app import asgi_app  # noqa: F401  (import-checked, then run by string)

    print(f"Python backend running on http://localhost:{config.PORT}")
    print("ASGI target: app:asgi_app (FastAPI + Socket.IO) — /socket.io/ is mounted")
    uvicorn.run(
        "app:asgi_app",
        host="0.0.0.0",
        port=config.PORT,
        log_level="info",
    )
