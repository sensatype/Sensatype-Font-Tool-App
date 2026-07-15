"""
API lokal Sensatype Font Tool (Fase 3) — FastAPI.

Jembatan browser (React/Vite) -> engine Python. Jalankan:
  source .venv/bin/activate
  uvicorn server.app:app --reload --port 8000
"""
from __future__ import annotations

import html
import os
import time

from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from server import auth
from server.project import library, project

app = FastAPI(title="Sensatype Font Tool")
# CORS: HANYA origin lokal (UI dev/preview). Wildcard "*" membiarkan situs mana pun membaca respons.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173",
                   "http://localhost:4173", "http://127.0.0.1:4173"],
    allow_methods=["*"], allow_headers=["*"],
)


def _origin_ok(ohost: str, rhost: str) -> bool:
    """Origin tepercaya: localhost, host sama dgn request, hostname .local, atau IP privat/LAN
    (akses dari perangkat lain di jaringan via proxy Vite). Situs web publik = ditolak."""
    if not ohost:
        return False
    if ohost in ("localhost", "127.0.0.1") or ohost == rhost or ohost.endswith(".local"):
        return True
    import ipaddress
    try:
        return ipaddress.ip_address(ohost).is_private
    except ValueError:
        return False


@app.middleware("http")
async def _reject_foreign_writes(request: Request, call_next):
    """Tolak request TULIS lintas-origin (anti-CSRF): CORS tak mencegah POST multipart terkirim,
    hanya pembacaan responsnya — tanpa cek ini, halaman web mana pun bisa menghapus project.
    Tanpa header Origin (curl, server-to-server) → lolos."""
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin:
            ohost = urlsplit(origin).hostname or ""
            rhost = (request.headers.get("host") or "").rsplit(":", 1)[0]
            if not _origin_ok(ohost, rhost):
                return JSONResponse({"detail": "Origin tidak diizinkan"}, status_code=403)
    return await call_next(request)


# Jalur auth + health boleh diakses tanpa login (health = probe; auth = pintu masuk).
_PUBLIC_PATHS = {
    "/api/health",
    "/api/auth/start", "/api/auth/callback", "/api/auth/session", "/api/auth/logout",
}


@app.middleware("http")
async def _require_login(request: Request, call_next):
    """Gerbangi SEMUA endpoint /api (baca & tulis) di belakang sesi Sensatype yang valid.
    Token disimpan di keyring sisi backend; introspeksi via /app-auth/verify (cache singkat)
    menegakkan pencabutan ~real-time. request.state.role diisi untuk gerbang role hilir."""
    path = request.url.path
    if (not auth.AUTH_DISABLED and request.method != "OPTIONS"
            and path.startswith("/api/") and path not in _PUBLIC_PATHS):
        sess = await run_in_threadpool(auth.current_session)
        if not sess.get("authenticated"):
            return JSONResponse({"detail": "Perlu login"}, status_code=401)
        if sess.get("allowed") is False:  # login sah tapi tak berhak masuk Font Tool (fitur #2)
            return JSONResponse({"detail": "Akses ditolak"}, status_code=403)
        request.state.userId = sess.get("userId")
        request.state.role = sess.get("role")
    return await call_next(request)


# ── Auth (OAuth2 authorization-code + PKCE; lihat server/auth.py) ───────────────
class AuthCallback(BaseModel):
    code: str
    state: str


@app.post("/api/auth/start")
async def auth_start():
    return await run_in_threadpool(auth.start_login)


@app.post("/api/auth/callback")
async def auth_callback(body: AuthCallback):
    """Mode BROWSER/SPA: route /auth/callback di React membaca code+state lalu POST ke sini."""
    return await run_in_threadpool(auth.complete_login, body.code, body.state)


def _callback_page(title: str, msg: str) -> str:
    return (
        "<!doctype html><meta charset=utf-8><title>Sensatype</title>"
        "<style>body{font-family:system-ui,-apple-system,sans-serif;background:#14171d;"
        "color:#e7eaf1;display:grid;place-items:center;height:100vh;margin:0}"
        ".c{text-align:center;max-width:22rem;padding:2rem}"
        ".d{width:44px;height:44px;border-radius:12px;background:#6d5efc;display:grid;"
        "place-items:center;color:#fff;font-weight:700;margin:0 auto 1rem}"
        "h1{font-size:1.05rem;margin:.3rem 0}p{color:#9aa4b2;font-size:.88rem;line-height:1.5}</style>"
        f"<div class=c><div class=d>S</div><h1>{html.escape(title)}</h1><p>{html.escape(msg)}</p></div>"
    )


@app.get("/api/auth/callback")
async def auth_callback_loopback(code: str | None = None, state: str | None = None,
                                 error: str | None = None):
    """Mode ELECTRON (loopback RFC 8252): browser sistem diarahkan ke URI ini (GET). Backend
    menukar code→token & menyimpannya di keyring, lalu menampilkan halaman 'boleh ditutup'.
    Aplikasi (renderer) mengetahui status lewat polling GET /api/auth/session — token tak
    pernah lewat browser. Pakai dgn SENSATYPE_REDIRECT_URI=http://127.0.0.1:8000/api/auth/callback."""
    if error:
        return HTMLResponse(_callback_page("Login dibatalkan", error), status_code=400)
    if not code or not state:
        return HTMLResponse(
            _callback_page("Tautan tidak lengkap", "Parameter code/state hilang."), status_code=400)
    try:
        await run_in_threadpool(auth.complete_login, code, state)
    except HTTPException as e:
        return HTMLResponse(_callback_page("Login gagal", str(e.detail)), status_code=e.status_code)
    return HTMLResponse(
        _callback_page("Login berhasil", "Aplikasi akan terbuka otomatis — jendela ini boleh ditutup."))


@app.get("/api/auth/session")
async def auth_session():
    return await run_in_threadpool(auth.current_session)


@app.post("/api/auth/logout")
async def auth_logout():
    return await run_in_threadpool(auth.logout)


# ── Pustaka project (multi-project, device-per-user) ────────────────────────────
@app.get("/api/projects")
async def projects_list():
    return {"projects": await run_in_threadpool(library.list), "active": library._active}


class NewProject(BaseModel):
    family: str = "Untitled"
    style: str = "Regular"


@app.post("/api/projects")
async def projects_create(body: NewProject):
    pid = await run_in_threadpool(library.create, body.family, body.style)
    return {"id": pid, "state": project.state()}


@app.post("/api/projects/{pid}/open")
async def projects_open(pid: str):
    try:
        await run_in_threadpool(library.open, pid)
    except KeyError:
        raise HTTPException(404, "Project tidak ada")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return project.state()


@app.delete("/api/projects/{pid}")
async def projects_delete(pid: str, _: dict = Depends(auth.require_role("admin", "atasan"))):
    try:
        return {"projects": await run_in_threadpool(library.delete, pid), "active": library._active}
    except ValueError as e:
        raise HTTPException(400, str(e))


class RenameProject(BaseModel):
    family: str


@app.patch("/api/projects/{pid}")
async def projects_rename(pid: str, body: RenameProject, _: dict = Depends(auth.require_role("admin", "atasan"))):
    try:
        return {"projects": await run_in_threadpool(library.rename, pid, body.family), "active": library._active}
    except KeyError:
        raise HTTPException(404, "Project tidak ada")
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/health")
def health():
    return {"ok": True, "hasProject": project.exists}


@app.get("/api/project")
def get_project():
    return project.state()


@app.post("/api/fit-all")
def fit_all():
    """Rapatkan sidebearing SEMUA glyph ke ink (LSB=0 & RSB=0)."""
    try:
        return project.fit_all(recompile=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Rapatkan semua gagal: {e}")


@app.get("/api/layouts")
def layouts():
    from server.project import ENGINE
    d = ENGINE / "layouts"
    return {"layouts": sorted(p.stem for p in d.glob("*.json"))}


@app.post("/api/import/specimen")
async def import_specimen(
    file: UploadFile = File(...),
    layout: str = Form(None),
    rows: str = Form("upper,lower"),
    family: str = Form("Untitled"),
    style: str = Form("Regular"),
    preset: str = Form("display-serif"),
):
    data = await file.read()
    try:
        return project.import_specimen(data, layout=layout or None, rows=rows,
                                       family=family, style=style, preset=preset)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Import gagal: {e}")


@app.post("/api/import/glyphs")
async def import_glyphs(
    files: list[UploadFile] = File(...),
    family: str = Form("Untitled"),
    style: str = Form("Regular"),
    preset: str = Form("display-serif"),
):
    payload = [(f.filename, await f.read()) for f in files]
    try:
        return project.import_glyphs(payload, family=family, style=style, preset=preset)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Import gagal: {e}")


@app.post("/api/import/stage")
async def import_stage(file: UploadFile = File(...)):
    data = await file.read()
    try:
        return project.stage_import(data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Stage gagal: {e}")


@app.get("/api/import/staging")
def import_staging():
    return project.staging_state()


class StageOp(BaseModel):
    op: str  # exclude | include | merge | split
    ids: list[int]


@app.post("/api/import/staging/op")
def import_staging_op(body: StageOp):
    return project.staging_op(body.op, body.ids)


class StageMove(BaseModel):
    ids: list[int]
    dx: float
    dy: float


@app.post("/api/import/staging/move")
def import_staging_move(body: StageMove):
    return project.staging_move(body.ids, body.dx, body.dy)


class Guides(BaseModel):
    guides: list


@app.post("/api/import/staging/guides")
def import_staging_guides(body: Guides):
    return project.set_guides(body.guides)


@app.post("/api/import/staging/undo")
def import_staging_undo():
    return project.staging_undo()


@app.post("/api/import/staging/redo")
def import_staging_redo():
    return project.staging_redo()


class Commit(BaseModel):
    tokens: list[str]
    family: str = "Untitled"
    style: str = "Regular"
    preset: str = "display-serif"


@app.post("/api/import/commit")
def import_commit(body: Commit):
    try:
        return project.commit_import(body.tokens, family=body.family, style=body.style, preset=body.preset)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Commit gagal: {e}")


@app.get("/api/import/progress")
def import_progress():
    # dibaca tanpa lock → poll berjalan mulus selagi commit memegang write-lock
    return project.import_progress()


@app.get("/api/glyph/{name}")
def glyph(name: str):
    if not project.exists:
        raise HTTPException(404, "Tidak ada project")
    try:
        return project.glyph_svg(name)
    except KeyError:
        raise HTTPException(404, f"Glyph '{name}' tidak ada")


class Spacing(BaseModel):
    lsb: float | None = None
    rsb: float | None = None
    recompile: bool = True  # False = tulis cepat; webfont menyusul via /preview/recompile (debounce UI)


@app.patch("/api/glyph/{name}/spacing")
def spacing(name: str, body: Spacing):
    try:
        r = project.set_spacing(name, lsb=body.lsb, rsb=body.rsb, recompile=body.recompile)
    except KeyError:
        raise HTTPException(404, f"Glyph '{name}' tidak ada")
    if r is None:
        raise HTTPException(400, "Glyph kosong")
    return r


class Metrics(BaseModel):
    ascender: float | None = None
    descender: float | None = None
    capHeight: float | None = None
    xHeight: float | None = None
    recompile: bool = True


@app.put("/api/metrics")
def metrics_vertical(body: Metrics):
    try:
        return project.set_metrics(body.ascender, body.descender, body.capHeight, body.xHeight,
                                   recompile=body.recompile)
    except ValueError as e:
        raise HTTPException(400, str(e))


class Outline(BaseModel):
    contours: list
    recompile: bool = True


class Simplify(BaseModel):
    tolerance: float = 3
    recompile: bool = False


@app.post("/api/glyph/{name}/simplify")
def glyph_simplify(name: str, body: Simplify):
    """Rapikan node/handle glyph (hapus titik berlebih, bentuk dipertahankan)."""
    try:
        return project.simplify_glyph(name, tolerance=body.tolerance, recompile=body.recompile)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, f"Rapikan gagal: {e}")


@app.patch("/api/glyph/{name}/outline")
def outline(name: str, body: Outline):
    try:
        return project.set_outline(name, body.contours, recompile=body.recompile)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Simpan outline gagal: {e}")


class Anchors(BaseModel):
    anchors: list


@app.put("/api/glyph/{name}/anchors")
def anchors(name: str, body: Anchors):
    try:
        return project.set_anchors(name, body.anchors)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Simpan anchor gagal: {e}")


class Components(BaseModel):
    components: list
    recompile: bool = True


@app.put("/api/glyph/{name}/components")
def components(name: str, body: Components):
    try:
        return project.set_components(name, body.components, recompile=body.recompile)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Simpan komponen gagal: {e}")


class Kern(BaseModel):
    left: str
    right: str
    value: float
    scope: str = "class"  # 'class' = level grup (semua se-kelas ikut) · 'pair' = exception
    recompile: bool = True  # False = tulis cepat tanpa compile webfont (saat menyetel live)


@app.get("/api/kerning")
def get_kern(left: str, right: str):
    return project.get_kern(left, right)


@app.get("/api/kerning/list")
def kern_list(q: str | None = None, limit: int = 400):
    return project.kern_list(q=q, limit=min(max(limit, 1), 2000))


@app.get("/api/kerning/smart")
def kern_smart(left: str, right: str):
    """Saran kern optikal (sadar-bentuk) utk satu pasangan — read-only, tak menulis."""
    try:
        return project.smart_kern(left, right)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, f"Smart kern gagal: {e}")


@app.put("/api/kerning")
def kern(body: Kern):
    try:
        return project.set_kerning(body.left, body.right, body.value, scope=body.scope, recompile=body.recompile)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, f"Kerning gagal: {e}")


class KernShift(BaseModel):
    delta: int
    recompile: bool = False


@app.post("/api/kerning/shift-all")
def kern_shift_all(body: KernShift):
    """Geser SEMUA nilai kerning tersimpan (bake permanen — scope 'Semuanya')."""
    try:
        return project.shift_all_kerning(body.delta, recompile=body.recompile)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Geser semua kerning gagal: {e}")


@app.post("/api/kerning/clear-all")
def kern_clear_all():
    """Nolkan SEMUA nilai kerning (grup kelas dipertahankan)."""
    try:
        return project.clear_all_kerning(recompile=False)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Nolkan kerning gagal: {e}")


class AutoKern(BaseModel):
    onlyEmpty: bool = True   # True = hanya isi pasangan yang belum ada kerning (tak menimpa)
    recompile: bool = False


@app.post("/api/kerning/auto")
def kern_auto(body: AutoKern):
    """Auto-kern optikal seluruh pasangan huruf & angka (sadar-bentuk). Aman: onlyEmpty=True."""
    try:
        return project.auto_kern_all(only_empty=body.onlyEmpty, recompile=body.recompile)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Auto-kern gagal: {e}")


@app.post("/api/preview/recompile")
def preview_recompile():
    return project.recompile_preview()


@app.post("/api/maintenance/fix-unicodes")
def fix_unicodes(_: dict = Depends(auth.require_role("admin", "atasan"))):
    """Perbaiki glyph karakter-tunggal tanpa unicode (data lama dari bug penamaan '_')."""
    return project.fix_missing_unicodes()


@app.get("/api/glyphs/render")
def glyphs_render():
    return project.glyphs_render()


class Tracking(BaseModel):
    value: float


@app.put("/api/tracking")
def tracking(body: Tracking):
    return project.set_tracking(body.value)


@app.post("/api/kerning/expand-groups")
def kern_expand_groups():
    try:
        return project.expand_kern_groups()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Perluas group gagal: {e}")


@app.put("/api/metadata")
def metadata(body: dict):
    return project.set_metadata(body)


class Respace(BaseModel):
    preset: str | None = None


@app.post("/api/respace")
def respace(body: Respace):
    return project.respace(preset=body.preset)


class Axis(BaseModel):
    tag: str = "wght"
    name: str = "Weight"
    min: float = 400
    max: float = 700
    default: float = 400


@app.put("/api/axis")
def set_axis(body: Axis):
    return project.set_axis(body.tag, body.name, body.min, body.max, body.default)


@app.post("/api/master")
async def add_master(
    file: UploadFile = File(...),
    value: float = Form(...),
    style: str = Form("Master"),
):
    data = await file.read()
    try:
        return project.add_master(data, value, style=style)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Tambah master gagal: {e}")


@app.get("/api/preview.woff2")
def preview():
    if not project.preview.exists():
        raise HTTPException(404, "Belum ada preview")
    return Response(project.preview.read_bytes(), media_type="font/woff2",
                    headers={"Cache-Control": "no-store"})


@app.get("/api/export")
def export(_: dict = Depends(auth.require_role("admin", "atasan", "senior", "member"))):
    if not project.exists:
        raise HTTPException(404, "Tidak ada project")
    buf, name = project.export_zip()
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}"'})


# SPA prod: bila UI sudah di-build (app/dist), layani dari backend agar shell Electron
# memuatnya SAME-ORIGIN dgn /api → tanpa isu CORS/CSRF, `/api` relatif tetap jalan. Dev
# memakai Vite (proxy /api). Mount TERAKHIR (catch-all "/") agar tak menaungi rute /api.
_DIST = Path(os.environ.get("SENSATYPE_DIST_DIR")
             or (Path(__file__).resolve().parent.parent / "app" / "dist"))
if _DIST.exists():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="spa")
