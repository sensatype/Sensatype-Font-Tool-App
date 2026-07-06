"""Entry point backend beku (PyInstaller) untuk aplikasi Electron terpasang.

Di mode dev, Electron menjalankan `python -m uvicorn server.app:app`. Di aplikasi
terpasang tak ada .venv/uvicorn CLI, jadi backend dibekukan menjadi satu executable
yang menjalankan uvicorn secara programatik lewat modul ini.
"""
from __future__ import annotations

import argparse

import uvicorn


def _selftest() -> int:
    """Validasi build beku dengan MENG-COMPILE font nyata (bukan sekadar impor) — agar
    submodul yang diimpor lazy saat kompilasi (mis. openstep_plist.util, cu2qu/qu2cu, feature
    writer ufo2ft) ketahuan bila hilang. Dipakai saat packaging/CI. Tak menyentuh data apa pun."""
    import tempfile
    from pathlib import Path

    import ufoLib2
    from fontmake.font_project import FontProject

    # UFO minimal 1 glyph, lalu compile OTF+TTF (persis seperti engine memakainya).
    font = ufoLib2.Font()
    font.info.familyName = "Selftest"
    font.info.styleName = "Regular"
    font.info.unitsPerEm = 1000
    font.info.ascender = 800
    font.info.descender = -200
    font.info.capHeight = 700
    font.info.xHeight = 500
    font.newGlyph(".notdef").width = 600
    sp = font.newGlyph("space"); sp.width = 250; sp.unicode = 0x20
    a = font.newGlyph("A"); a.width = 600; a.unicode = 0x41
    pen = a.getPen()
    pen.moveTo((50, 0)); pen.lineTo((550, 0)); pen.lineTo((300, 700)); pen.closePath()

    with tempfile.TemporaryDirectory() as td:
        ufo_path = Path(td) / "selftest.ufo"
        font.save(ufo_path)
        FontProject().run_from_ufos([str(ufo_path)], output=("otf", "ttf"), output_dir=td)
        outs = list(Path(td).rglob("*.otf")) + list(Path(td).rglob("*.ttf"))
        if not outs:
            raise RuntimeError("fontmake tidak menghasilkan OTF/TTF")

    # PyMuPDF: buat PDF kosong 1 halaman → memicu MuPDF native lib.
    import fitz
    doc = fitz.open()
    doc.new_page(width=200, height=200)
    n = doc.page_count
    doc.close()
    # skia-pathops native (operasi boolean sederhana).
    import pathops
    pen2 = pathops.Path()
    pen2.moveTo(0, 0); pen2.lineTo(10, 0); pen2.lineTo(10, 10); pen2.close()
    pathops.simplify(pen2)

    print(f"SELFTEST OK — compile fontmake OTF+TTF ({len(outs)} berkas), PyMuPDF({n}p), skia-pathops")
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
