# syntax=docker/dockerfile:1

# Two stages. The split exists so the runtime image carries neither uv nor a
# dev dependency (ruff, mypy): the venv is resolved once from uv.lock in the
# builder and copied whole, so the runtime stage needs no package manager and
# no network at all.
#
# The Node siblings compile; this one does not. `uv sync` is the build step.

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
# The uv image is only a Python + uv toolbox; nothing from it ships. Keep the
# minor version in step with the runtime stage below: the venv it builds is
# copied as-is, and a venv is tied to its interpreter's minor version.
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim AS deps

WORKDIR /app

# Byte-compile on install (slower build, faster first request) and copy rather
# than hardlink out of uv's cache, which lives on a different mount here.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

# Only what the resolver reads, so a change to server.py or a doc does not
# re-resolve and re-download every wheel.
COPY pyproject.toml uv.lock ./

# --frozen: build from the lockfile exactly, and fail if it disagrees with
#   pyproject.toml, rather than quietly resolving something newer than what was
#   tested. --no-dev leaves ruff and mypy behind: they run in CI, not in a
#   container. `[tool.uv] package = false` means there is no project to install
#   either — this service runs from its root, like `tsx src/server.ts` does.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM python:3.13-slim-bookworm AS runtime

# Logs are the only output that matters and they go to stdout as JSON — an
# unflushed buffer on SIGTERM loses the shutdown lines. No .pyc writes either:
# the venv is already compiled and the source tree is read-only in practice.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/app/.venv/bin:$PATH

WORKDIR /app

COPY --from=deps /app/.venv /app/.venv

# The service, one directory per layer of `app -> lib, pkg`. Everything else in
# the context (docs, play/, .env) is either irrelevant to the process or must
# never be in an image; see .dockerignore.
COPY server.py ./
COPY pkg ./pkg
COPY lib ./lib
COPY app ./app

# Unprivileged, and created here: the python image ships no non-root user.
# Nothing the service writes goes to the filesystem, so root-owned files it can
# only read are correct.
RUN useradd --create-home --uid 10001 analytics
USER analytics

EXPOSE 4100

# /health answers 200 whenever the process can serve a read, and reports
# `"status": "degraded"` with `"rabbit": "down"` instead of failing — a broker
# blip must not get this replica pulled from the load balancer while reads
# still work (server.py says the same). So the probe checks reachability, not
# the body: a container that fails this cannot serve HTTP at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','4100')+'/health',timeout=4).read()"]

# Not uvicorn's CLI: server.py owns the wiring, the consumer and the ordered
# shutdown, and uvicorn runs inside it (see `_Server`). Exec form, so the
# process is PID 1 and gets SIGTERM directly.
CMD ["python", "server.py"]
