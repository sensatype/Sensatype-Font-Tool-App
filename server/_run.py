"""Entry point backend beku (PyInstaller) untuk aplikasi Electron terpasang.

Di mode dev, Electron menjalankan `python -m uvicorn server.app:app`. Di aplikasi
terpasang tak ada .venv/uvicorn CLI, jadi backend dibekukan menjadi satu executable
yang menjalankan uvicorn secara programatik lewat modul ini.
"""
from __future__ import annotations

import argparse

import uvicorn

from server.app import app  # noqa: F401  (dipakai uvicorn via referensi objek)


def main() -> None:
    p = argparse.ArgumentParser(prog="sensatype-backend")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    a = p.parse_args()
    uvicorn.run(app, host=a.host, port=a.port, log_level="info")


if __name__ == "__main__":
    main()
