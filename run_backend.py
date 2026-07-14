"""Entry backend beku (PyInstaller) — model "isi bisa di-update tanpa reinstall".

Yang DIBEKUKAN di binari ini hanya: interpreter Python + library pihak-ketiga
(fontmake/fontTools/PyMuPDF/…). Kode aplikasi sendiri — paket `server/` + `engine/` +
UI `dist/` — dikirim sebagai FILE NYATA di "content dir" dan dimuat saat runtime, jadi
bisa diperbarui lewat paket kecil tanpa mengganti installer.

Content dir diberi tahu lewat env SENSATYPE_CONTENT_DIR (di-set shell Electron). Berisi:
  <content>/server/  <content>/engine/  <content>/dist/  <content>/meta.json
"""
from __future__ import annotations

import argparse
import os
import sys

import uvicorn


def _add_content_to_path() -> None:
    """Taruh content dir di depan sys.path → `import server.app` memuat dari FILE NYATA
    (bukan beku). engine dimuat server.project via SENSATYPE_ENGINE_DIR."""
    content = os.environ.get("SENSATYPE_CONTENT_DIR")
    if content and os.path.isdir(content) and content not in sys.path:
        sys.path.insert(0, content)
    # Mode dev (tak beku): file ini di root repo → `server/` sudah relatif; tak perlu apa-apa.


def _selftest() -> int:
    """Validasi library berat hidup di build beku (server/engine TIDAK dibutuhkan di sini)."""
    from fontmake.font_project import FontProject  # noqa: F401
    import fitz
    doc = fitz.open()
    doc.new_page(width=200, height=200)
    n = doc.page_count
    doc.close()
    import pathops
    pen = pathops.Path()
    pen.moveTo(0, 0); pen.lineTo(10, 0); pen.lineTo(10, 10); pen.close()
    pathops.simplify(pen)
    print(f"SELFTEST OK — fontmake, PyMuPDF({n}p), skia-pathops hidup di build beku")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(prog="sensatype-backend")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--selftest", action="store_true", help="validasi library lalu keluar")
    a = p.parse_args()
    if a.selftest:
        raise SystemExit(_selftest())
    _add_content_to_path()
    from server.app import app  # dimuat dari content dir (real files)
    uvicorn.run(app, host=a.host, port=a.port, log_level="info")


if __name__ == "__main__":
    main()
