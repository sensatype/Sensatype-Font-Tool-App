# PyInstaller (onedir) — backend Sensatype Font Tool.
#
# CATATAN penting: engine/ TIDAK dibekukan di sini. Ia dikirim sebagai FILE NYATA lewat
# electron-builder (extraResources → resources/engine) dan dimuat saat runtime via
# SENSATYPE_ENGINE_DIR (sys.path). Ini menjaga resolusi __file__ modul engine + data JSON-nya.
# Spec ini hanya membekukan interpreter Python + library pihak-ketiga + paket `server`.
from PyInstaller.utils.hooks import collect_all

_libs = [
    "fontmake", "ufo2ft", "fontTools", "ufoLib2", "picosvg", "pathops",
    "fontMath", "booleanOperations", "glyphsLib", "openstep_plist", "fitz",
    "unicodedata2", "uvicorn", "fastapi", "starlette", "keyring", "httpx",
    "anyio", "multipart", "pydantic", "pydantic_core",
]

datas, binaries, hiddenimports = [], [], []
for _m in _libs:
    d, b, h = collect_all(_m)
    datas += d
    binaries += b
    hiddenimports += h

# Modul yang dimuat dinamis (tak terdeteksi analisis statis).
hiddenimports += [
    "keyring.backends.macOS", "keyring.backends.Windows",
    "keyring.backends.SecretService", "keyring.backends.chainer",
    "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on",
]

a = Analysis(
    ["run_backend.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    # `server` & modul engine SENGAJA TIDAK dibekukan — dimuat runtime dari content dir
    # (agar bisa di-update tanpa reinstall). Library-nya tetap dibekukan (collect_all di atas).
    excludes=["server", "smoke_test", "htls", "kerning", "presets", "specimen_split",
              "features", "variable", "simplify",
              "tkinter", "matplotlib", "PyQt5", "PyQt6", "PySide2", "PySide6", "IPython", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="sensatype-backend",
    console=True,
)
coll = COLLECT(exe, a.binaries, a.datas, name="sensatype-backend")
