# Marks `backend` as an explicit Python package so relative imports
# (`from .system_settings import ...`, `from .parsers.gcms_agilent
# import ...`) resolve correctly when uvicorn is invoked as
# `backend.server:app` from the repo root.
#
# Without this file, Python treats the directory as a PEP-420
# namespace package, which is fine for `python -m uvicorn
# backend.server:app` but breaks under `python -m uvicorn server:app
# --app-dir backend` — that flag puts `backend/` on sys.path and
# imports `server` as a TOP-LEVEL module, at which point relative
# imports raise "no known parent package." The launcher script now
# uses the correct invocation, and this __init__.py exists as a
# belt-and-suspenders guard so future invocations can't accidentally
# regress to the broken shape.
