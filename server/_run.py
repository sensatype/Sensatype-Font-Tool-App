"""Entry point backend beku (PyInstaller) untuk aplikasi Electron terpasang.

Di mode dev, Electron menjalankan `python -m uvicorn server.app:app`. Di aplikasi
terpasang tak ada .venv/uvicorn CLI, jadi backend dibekukan menjadi satu executable
yang menjalankan uvicorn secara programatik lewat modul ini.
"""
from __future__ import annotations

import argparse

import uvicorn


def _selftest() -> int:
    """Validasi library berat yang diimpor lazy benar-benar hidup di build beku.
    Dipakai saat packaging/CI: `sensatype-backend --selftest`. Tak menyentuh data apa pun."""
    # fontmake + rantai kompilasinya (ufo2ft, feaLib, dll.)
    from fontmake.font_project import FontProject  # noqa: F401
    # PyMuPDF: buat PDF kosong 1 halaman → memicu MuPDF native lib.
    import fitz
    doc = fitz.open()
    doc.new_page(width=200, height=200)
    n = doc.page_count
    doc.close()
    # skia-pathops native (operasi boolean sederhana).
    import pathops
    pen = pathops.Path()
    pen.moveTo(0, 0); pen.lineTo(10, 0); pen.lineTo(10, 10); pen.close()
    pathops.simplify(pen)
    print(f"SELFTEST OK — fontmake+ufo2ft, PyMuPDF({n}p), skia-pathops semua hidup di build beku")
    return 0


def main() -> None:
    p = argparse.ArgumentParser(prog="sensatype-backend")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--selftest", action="store_true", help="validasi library berat lalu keluar")
    a = p.parse_args()
    if a.selftest:
        raise SystemExit(_selftest())
    # Impor app DITUNDA: butuh engine di sys.path (SENSATYPE_ENGINE_DIR) — tak diperlukan --selftest.
    from server.app import app
    uvicorn.run(app, host=a.host, port=a.port, log_level="info")


if __name__ == "__main__":
    main()
