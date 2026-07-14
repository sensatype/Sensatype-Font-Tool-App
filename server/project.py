"""
Manajemen project untuk API lokal (Fase 3).

Project = satu workspace berisi UFO (sumber kebenaran, PRD §5) + project.json (metadata)
+ preview.woff2 (untuk render @font-face di browser). Membungkus engine Python:
specimen_split / smoke_test.build_ufo / htls / kerning / presets / fontmake.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import sys
import threading
import time
import zipfile
from pathlib import Path

# ENGINE bisa di-override (SENSATYPE_ENGINE_DIR) untuk aplikasi beku/terpasang, di mana
# engine dikirim sebagai file nyata di resources/ (bukan dibekukan ke dalam bundle).
ENGINE = Path(os.environ.get("SENSATYPE_ENGINE_DIR")
              or (Path(__file__).resolve().parent.parent / "engine"))
sys.path.insert(0, str(ENGINE))

import ufoLib2  # noqa: E402
from fontTools.pens.svgPathPen import SVGPathPen  # noqa: E402

import smoke_test  # noqa: E402  (build_ufo, compile_with_fontmake, wrap_web)
import htls  # noqa: E402
import kerning as kerning_mod  # noqa: E402
import presets as presets_mod  # noqa: E402
import specimen_split  # noqa: E402
import features as features_mod  # noqa: E402
import simplify as simplify_mod  # noqa: E402

# WORKSPACE = project "lama" (satu-project). Kini jadi CADANGAN + sumber migrasi ke pustaka.
# PROJECTS_ROOT = pustaka multi-project (model device-per-user). Keduanya bisa di-override env
# (dipakai saat uji agar tak menyentuh data font asli).
WORKSPACE = Path(os.environ.get("SENSATYPE_LEGACY_WORKSPACE",
                                str(Path(__file__).resolve().parent / "workspace")))
PROJECTS_ROOT = Path(os.environ.get("SENSATYPE_PROJECTS_DIR",
                                    str(Path(__file__).resolve().parent / "projects")))

_META_FIELDS = {
    "designer": "openTypeNameDesigner",
    "designerURL": "openTypeNameDesignerURL",
    "license": "openTypeNameLicense",
    "licenseURL": "openTypeNameLicenseURL",
    "copyright": "copyright",
    "trademark": "trademark",
    "sampleText": "openTypeNameSampleText",
}


import re as _re
import unicodedata as _ud

_ALT_SUFFIX = _re.compile(r"^(ss\d{2}|salt|alt\d*|cv\d{2})$")
# huruf KHUSUS yang berada di blok simbol/tanda-baca (bukan "multilingual beraksen") —
# tetap di kategori "Simbol & tanda baca", walau codepoint-nya ≥0xC0 & berjenis huruf.
_PUNCT_LETTERS = set("ıæœÆŒØøß")


def _category(name, cp):
    # berdasarkan NAMA glyph dulu (alternate/ligature)
    # ligatur = nama ber-"_" dgn SEMUA komponen non-kosong (mis. f_i, R_A) — BUKAN glyph "_" (underscore) sendiri
    if "." not in name and "_" in name and all(name.split("_")):
        return "ligature"
    if "." in name and _ALT_SUFFIX.match(name.split(".", 1)[1]):
        return "alternate"
    if cp:
        if 0x41 <= cp <= 0x5A:
            return "uppercase"
        if 0x61 <= cp <= 0x7A:
            return "lowercase"
        if 0x30 <= cp <= 0x39:
            return "figures"
        if chr(cp) in _PUNCT_LETTERS:      # æ œ ø ß … = blok simbol, BUKAN multilingual
            return "other"
        # huruf beraksen / Latin diperluas = multilingual. KECUALIKAN modifier letter (Lm: ˆ ˇ ¯ …) yg
        # sebetulnya aksen/simbol spasi (bukan huruf yg diketik), spt acute/grave/dieresis → "other".
        uc = _ud.category(chr(cp))
        if cp >= 0xC0 and uc[0] == "L" and uc != "Lm":
            return "multilingual"
    return "other"


def _pdf_to_svg(data: bytes) -> bytes:
    """Konversi PDF (vektor) → SVG: teks jadi outline path, SEMUA halaman ditumpuk vertikal
    jadi satu SVG. Origin tiap halaman dinormalkan ke 0 (aman utk PDF ber-MediaBox tak-nol)."""
    import fitz  # PyMuPDF (bawa MuPDF sendiri, tanpa binari sistem)
    from xml.etree import ElementTree as ET
    SVG_NS = "http://www.w3.org/2000/svg"
    ET.register_namespace("", SVG_NS)
    doc = fitz.open(stream=data, filetype="pdf")
    try:
        parts, y, maxw = [], 0.0, 1.0
        for page in doc:
            svg = page.get_svg_image(text_as_path=True)  # teks → path vektor
            # namespace id per halaman: id clipPath/defs antarhalaman sama (cp0, …) → referensi
            # resolve ke kemunculan PERTAMA se-dokumen; halaman ≥2 bisa terpotong clip halaman 1.
            pid = f"pg{page.number}_"
            svg = (svg.replace('id="', f'id="{pid}')
                      .replace('url(#', f'url(#{pid}')
                      .replace('href="#', f'href="#{pid}'))
            root = ET.fromstring(svg)
            vb = (root.get("viewBox") or "").split()
            if len(vb) == 4:
                vx, vy, vw, vh = (float(v) for v in vb)
            else:
                vx, vy, vw, vh = 0.0, 0.0, float(page.rect.width), float(page.rect.height)
            inner = "".join(ET.tostring(ch, encoding="unicode") for ch in list(root))
            parts.append(f'<g transform="translate({-vx} {y - vy})">{inner}</g>')
            y += vh
            maxw = max(maxw, vw)
        if not parts:
            raise ValueError("PDF tidak punya halaman yang bisa dibaca.")
        return (f'<svg xmlns="{SVG_NS}" viewBox="0 0 {maxw} {y}" '
                f'width="{maxw}" height="{y}">' + "".join(parts) + "</svg>").encode("utf-8")
    finally:
        doc.close()


def _to_svg_bytes(data: bytes) -> bytes:
    """Terima berkas import SVG atau PDF. PDF dideteksi via magic '%PDF-' lalu dikonversi ke
    SVG (masuk pipeline specimen yang sama). SVG diteruskan apa adanya."""
    return _pdf_to_svg(data) if data[:5] == b"%PDF-" else data


def _locked(fn):
    """Serialize operasi tulis UFO (self._write_lock, RLock) → cegah save bersamaan."""
    def wrap(self, *a, **k):
        with self._write_lock:
            return fn(self, *a, **k)
    return wrap


def _fit_to_ink(font):
    """Rapatkan sidebearing SEMUA glyph ke ink: LSB=0 & RSB=0 (advance = lebar ink). Mutasi font
    IN-PLACE, tidak menyimpan. Order-independent (pakai bounds asli) & aman komposit (offset
    komponen dikompensasi agar huruf beraksen tak bergeser relatif). Return jumlah glyph diproses."""
    order = [n for n in font.glyphOrder if n != ".notdef" and n in font]
    bounds = {}
    for n in order:
        b = font[n].getBounds(font)
        if b is not None and b.xMax > b.xMin:  # ada ink; lewati glyph kosong (spasi)
            bounds[n] = (b.xMin, b.xMax)
    dx = {n: -xy[0] for n, xy in bounds.items()}
    for n, (xMin, xMax) in bounds.items():
        g = font[n]
        d = dx[n]
        if d:
            for c in g:
                for p in c:
                    p.x += d
            for a in g.anchors:
                a.x += d
        for comp in g.components:  # ikut geser +d, tapi base-nya juga digeser → kompensasi
            t = list(comp.transformation)
            # base bergeser dx[base]; efeknya di komposit = xScale*dx[base] (skala komponen ikut).
            # Untuk komponen mirror/scaled (xScale≠1) faktor ini WAJIB, kalau tidak huruf beraksen
            # yang memakai komponen dicerminkan/diperkecil akan meloncat horizontal.
            t[4] += d - t[0] * dx.get(comp.baseGlyph, 0)
            comp.transformation = tuple(t)
        g.width = round(xMax + d)
    return len(bounds)


class Project:
    def __init__(self, root: Path = WORKSPACE):
        self.root = root
        self.glyph_dir = root / "glyphs"
        self.ufo_path = root / "project.ufo"
        self.meta_path = root / "project.json"
        self.preview = root / "preview.woff2"
        self._version = 0
        self._static_glyphs = []
        self._history = []   # snapshot staging utk undo
        self._redo = []
        # serialize semua operasi tulis UFO (font.save) — FastAPI sync endpoint jalan di
        # threadpool, save bersamaan bisa MERUSAK UFO (mis. lib.plist/glyphOrder hilang).
        self._write_lock = threading.RLock()
        # progres commit import (dibaca via GET /api/import/progress, tanpa lock → poll mulus)
        self._progress = {"pct": 0, "phase": "", "active": False, "error": None}

    def _set_progress(self, pct, phase, *, active=True, error=None):
        # ganti referensi dict (atomik di GIL) → pembaca tak pernah lihat keadaan setengah jadi
        self._progress = {"pct": int(pct), "phase": phase, "active": active, "error": error}

    def import_progress(self):
        return dict(self._progress)

    def rebind(self, root):
        """Arahkan ulang instance ini ke dir project lain (ganti project aktif). Referensi
        `project` di app.py tetap valid — kita hanya mengubah path & reset cache/lock state."""
        with self._write_lock:
            self.root = Path(root)
            self.glyph_dir = self.root / "glyphs"
            self.ufo_path = self.root / "project.ufo"
            self.meta_path = self.root / "project.json"
            self.preview = self.root / "preview.woff2"
            self._version = 0
            self._static_glyphs = []
            self._history = []
            self._redo = []
            self._progress = {"pct": 0, "phase": "", "active": False, "error": None}

    # --- state -------------------------------------------------------------
    @property
    def exists(self):
        return self.ufo_path.exists()

    def _meta(self):
        if self.meta_path.exists():
            return json.loads(self.meta_path.read_text())
        return {}

    def _save_meta(self, meta):
        self.meta_path.write_text(json.dumps(meta, indent=2))

    def _font(self):
        return ufoLib2.Font.open(self.ufo_path)

    # --- import ------------------------------------------------------------
    def _fresh_root(self):
        """Dir kerja SEMENTARA utk membangun project pengganti. Workspace lama TIDAK disentuh
        sampai build sukses → import gagal tak menghapus project yang sedang jalan."""
        tmp = self.root.parent / (self.root.name + "_new")
        if tmp.exists():
            shutil.rmtree(tmp)
        return tmp

    def _swap_root(self, tmp):
        """Build sukses → baru buang workspace lama dan pasang penggantinya."""
        if self.root.exists():
            shutil.rmtree(self.root)
        tmp.rename(self.root)

    @_locked
    def import_specimen(self, svg_bytes, *, layout=None, rows="upper,lower",
                        family="Untitled", style="Regular", preset="display-serif"):
        svg_bytes = _to_svg_bytes(svg_bytes)  # terima SVG atau PDF
        tmp = self._fresh_root()
        gdir = tmp / "glyphs"
        gdir.mkdir(parents=True)
        spec = tmp / "_specimen.svg"
        spec.write_bytes(svg_bytes)
        self._split(spec, gdir, layout, rows)
        self._build_ufo_at(gdir, tmp / "project.ufo", family, style, preset, fit_ink=True, zero_kern=True)
        self._swap_root(tmp)  # sukses → ganti workspace lama
        meta = {"family": family, "style": style, "upm": 1000, "preset": preset,
                "layout": layout, "rows": rows,
                "masters": [{"value": None, "ufo": "project.ufo", "name": style}], "axis": None}
        self._save_meta(meta)
        self.compile_preview()
        return self.state()

    @_locked
    def import_glyphs(self, files, *, family="Untitled", style="Regular", preset="display-serif"):
        """files = list of (filename, bytes). Tiap file = 1 glyph (nama file -> unicode)."""
        # validasi nama DULU (sebelum menulis apa pun): basename .svg saja → cegah path traversal
        for name, _ in files:
            safe = Path(str(name or "")).name
            if not safe or safe != name or not safe.lower().endswith(".svg"):
                raise ValueError(f"Nama file tidak valid: {name!r} (harus .svg tanpa path)")
        if not self.exists:
            # PROJECT BARU → build di dir SEMENTARA lalu swap (anti data-loss: build gagal TIDAK
            # menghapus dir project yang ada, mis. yang baru dibuat lewat pustaka).
            fam, sty, pre = family, style, preset
            tmp = self._fresh_root()
            gdir = tmp / "glyphs"
            gdir.mkdir(parents=True)
            for name, data in files:
                (gdir / name).write_bytes(data)
            self._build_ufo_at(gdir, tmp / "project.ufo", fam, sty, pre, fit_ink=True, zero_kern=True)  # gagal → tmp dibuang, root utuh
            meta = {"family": fam, "style": sty, "upm": 1000, "preset": pre, "layout": None,
                    "rows": "upper,lower",
                    "masters": [{"value": None, "ufo": "project.ufo", "name": sty}], "axis": None}
            (tmp / "project.json").write_text(json.dumps(meta, indent=2))
            self._swap_root(tmp)
            self.compile_preview()
            return self.state()
        # PROJECT ADA → tambah glyph incremental; build ke UFO sementara lalu rename (project.ufo lama aman)
        self.glyph_dir.mkdir(parents=True, exist_ok=True)
        for name, data in files:
            (self.glyph_dir / name).write_bytes(data)
        meta = self._meta()
        fam, sty, pre = meta.get("family", family), meta.get("style", style), meta.get("preset", preset)
        tmp_ufo = self.root / "project_new.ufo"
        if tmp_ufo.exists():
            shutil.rmtree(tmp_ufo)
        self._build_ufo_at(self.glyph_dir, tmp_ufo, fam, sty, pre, fit_ink=True, zero_kern=True)
        if self.ufo_path.exists():
            shutil.rmtree(self.ufo_path)
        tmp_ufo.rename(self.ufo_path)
        self.compile_preview()
        return self.state()

    # --- staging import (preview → bersihkan → map token → commit) ---------
    # Deret auto SETELAH 0-9: simbol + tanda baca + diakritik (urutan standar Sensatype).
    # Kutip dipakai set unik terverifikasi (’”‘ ' “ " ‚ „) utk hindari codepoint dobel.
    _PUNCT_BLOCK = list(
        "¹²³ªº"
        "%‰$€¥£¢&*@#|"
        "ıæœÆŒØøß™"
        ",.:;-–—_·•…"
        "\u2019\u201d\u2018\u0027\u201c\u0022\u201a\u201e"  # 8 kutip (quoteright/dblright/left/single/dblleft/dbl/sglbase/dblbase)
        "<>‹›«»/\\?!¡¿"                            # <>‹›«»/\?!¡¿
        "()[]{}©®§+×=°†"                           # ()[]{}©®§+×=°† (tanpa caret ^; circumflex ada di diakritik)
        "ˇˆ¨˜`´˚¸")  # caron circumflex dieresis tilde grave acute ring cedilla
    # 58 karakter terakhir = multilingual (29 kapital + 29 minuscule)
    _MULTILINGUAL = list(
        "ÀÁÂÃÄÅÇÈÉÊË"
        "ÌÍÎÏÑÒÓÔÕÖŠ"
        "ÙÚÛÜÝŸŽ"
        "àáâãäåçèéêë"
        "ìíîïñòóôõöš"
        "ùúûüýÿž")

    @property
    def staging_path(self):
        return self.root / "_staging.json"

    def _load_staging(self):
        if self.staging_path.exists():
            return json.loads(self.staging_path.read_text())
        return {"shapes": []}

    def _save_staging(self, st):
        self.root.mkdir(parents=True, exist_ok=True)
        self.staging_path.write_text(json.dumps(st))

    def _snapshot(self):
        """Simpan state staging saat ini ke history (untuk undo) + reset redo."""
        import copy
        if self.staging_path.exists():
            self._history.append(copy.deepcopy(self._load_staging()))
            self._history = self._history[-60:]
            self._redo.clear()

    @_locked
    def staging_undo(self):
        if self._history:
            self._redo.append(self._load_staging())
            self._save_staging(self._history.pop())
        return self.staging_state()

    @_locked
    def staging_redo(self):
        if self._redo:
            self._history.append(self._load_staging())
            self._save_staging(self._redo.pop())
        return self.staging_state()

    def _reorder(self, shapes):
        shapes.sort(key=lambda s: (s["band"], (s["bbox"][0] + s["bbox"][2]) / 2))
        return shapes

    @_locked
    def stage_import(self, svg_bytes):
        """Ekstrak semua glyph (MENTAH, urutan baca) + garis panduan. Belum build font."""
        svg_bytes = _to_svg_bytes(svg_bytes)  # terima SVG atau PDF
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.root / "_stage.svg"
        tmp.write_bytes(svg_bytes)
        res = specimen_split.extract_shapes(tmp)
        shapes = [{"id": i, "paths": s["paths"], "bbox": s["bbox"],
                   "band": s["band"], "excluded": False} for i, s in enumerate(res["shapes"])]
        guides = [{"id": i, "y": g["y"], "type": g["type"]} for i, g in enumerate(res["guides"])]
        self._save_staging({"shapes": shapes, "guides": guides, "viewBox": res["viewBox"],
                            "nextId": len(shapes), "nextGid": len(guides)})
        self._history = []
        self._redo = []
        return self.staging_state()

    def staging_state(self):
        st = self._load_staging()
        kept = [s for s in st["shapes"] if not s.get("excluded")]
        auto = self._auto_tokens(len(kept))
        return {
            "shapes": [{"id": s["id"], "d": " ".join(s["paths"]), "bbox": s["bbox"],
                        "band": s["band"], "excluded": s.get("excluded", False)}
                       for s in st["shapes"]],
            "guides": st.get("guides", []),
            "viewBox": st.get("viewBox", [0, 0, 1, 1]),
            "autoTokens": auto,
            "keptCount": len(kept),
            "canUndo": bool(self._history),
            "canRedo": bool(self._redo),
        }

    @_locked
    def set_guides(self, guides):
        """Ganti seluruh daftar garis panduan (frontend kirim full list setelah seret/Alt-copy/hapus)."""
        self._snapshot()
        st = self._load_staging()
        gid = st.get("nextGid", 0)
        norm = []
        for g in guides:
            i = g.get("id")
            if i is None:
                i = gid; gid += 1
            norm.append({"id": i, "y": round(float(g["y"]), 1),
                         "type": "cap" if g.get("type") == "cap" else "baseline",
                         "linked": bool(g.get("linked", True))})  # linked=False → lepas dari grup se-tipe
        st["guides"] = norm
        st["nextGid"] = gid
        self._save_staging(st)
        return self.staging_state()

    def _auto_tokens(self, n):
        # prefix dari awal: A-Z, a-z, 0-9, lalu blok simbol/tanda-baca/diakritik
        prefix = ([chr(c) for c in range(0x41, 0x5B)] + [chr(c) for c in range(0x61, 0x7B)]
                  + [str(d) for d in range(10)] + self._PUNCT_BLOCK)
        out = [""] * n
        for i in range(min(len(prefix), n)):
            out[i] = prefix[i]
        # 58 posisi TERAKHIR = multilingual (tanpa menimpa prefix; tengah = alt/liga manual)
        ml = self._MULTILINGUAL
        for j, tok in enumerate(ml):
            idx = n - len(ml) + j
            if idx >= len(prefix) and 0 <= idx < n:
                out[idx] = tok
        return out

    @_locked
    def staging_op(self, op, ids):
        self._snapshot()
        st = self._load_staging()
        shapes = st["shapes"]
        idset = set(ids)
        if op in ("exclude", "include"):
            for s in shapes:
                if s["id"] in idset:
                    s["excluded"] = (op == "exclude")
        elif op == "merge" and len(ids) >= 2:
            members = [s for s in shapes if s["id"] in idset]
            if len(members) < 2:  # id basi (mis. setelah undo) → jangan 500, kembalikan state apa adanya
                return self.staging_state()
            keep = members[0]
            for m in members[1:]:
                keep["paths"] += m["paths"]
            xs = [keep["bbox"][0], keep["bbox"][2]] + [c for m in members[1:] for c in (m["bbox"][0], m["bbox"][2])]
            ys = [keep["bbox"][1], keep["bbox"][3]] + [c for m in members[1:] for c in (m["bbox"][1], m["bbox"][3])]
            keep["bbox"] = [min(xs), min(ys), max(xs), max(ys)]
            keep["band"] = min(m["band"] for m in members)
            st["shapes"] = [s for s in shapes if s["id"] not in idset or s is keep]
        elif op == "split":
            out = []
            nid = st.get("nextId", len(shapes))
            from fontTools.svgLib.path import parse_path
            from fontTools.pens.boundsPen import ControlBoundsPen
            for s in shapes:
                if s["id"] in idset and len(s["paths"]) > 1:
                    for d in s["paths"]:
                        p = ControlBoundsPen(None)
                        try:
                            parse_path(d, p)
                        except Exception:
                            continue
                        bb = list(p.bounds) if p.bounds else s["bbox"]
                        out.append({"id": nid, "paths": [d], "bbox": bb,
                                    "band": s["band"], "excluded": s.get("excluded", False)})
                        nid += 1
                else:
                    out.append(s)
            st["shapes"] = out
            st["nextId"] = nid
        self._reorder(st["shapes"])
        self._save_staging(st)
        return self.staging_state()

    @_locked
    def staging_move(self, ids, dx, dy):
        """Geser shape terpilih sebesar (dx,dy) koordinat SVG: translasi path + bbox.
        TIDAK reorder (urutan baca dipertahankan) → posisi manual tidak mengubah urutan token."""
        from fontTools.pens.transformPen import TransformPen
        from fontTools.svgLib.path import parse_path
        self._snapshot()
        st = self._load_staging()
        idset = set(ids)
        for s in st["shapes"]:
            if s["id"] in idset:
                np = []
                for d in s["paths"]:
                    sp = SVGPathPen(None)
                    parse_path(d, TransformPen(sp, (1, 0, 0, 1, dx, dy)))
                    np.append(sp.getCommands())
                s["paths"] = np
                b = s["bbox"]
                s["bbox"] = [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy]
        self._save_staging(st)
        return self.staging_state()

    @_locked
    def commit_import(self, tokens, *, family, style, preset):
        try:
            return self._commit_import(tokens, family=family, style=style, preset=preset)
        except Exception as e:
            self._set_progress(0, "Gagal", active=False, error=str(e))
            raise

    def _commit_import(self, tokens, *, family, style, preset):
        from fontTools.svgLib.path import parse_path
        from fontTools.pens.transformPen import TransformPen
        self._set_progress(2, "Menyiapkan…")
        st = self._load_staging()
        kept = [s for s in st["shapes"] if not s.get("excluded")]
        guides = st.get("guides", [])
        baselines = sorted(g["y"] for g in guides if g.get("type") != "cap")
        caps = sorted(g["y"] for g in guides if g.get("type") == "cap")
        margin, upm, baseY, cap_target = 60, 1000, 800.0, 700.0

        def metrics_for(bbox):
            """Baseline = garis baseline terdekat ke dasar glyph; cap = garis cap terdekat di atasnya.
            scale = cap_target / (baseline - cap). Normalisasi: dasar baris → baseY (Y-down)."""
            ybot = bbox[3]
            if baselines:
                bl = min(baselines, key=lambda y: abs(y - ybot))
            else:
                bl = ybot
            caps_above = [c for c in caps if c < bl]
            cap = max(caps_above) if caps_above else (min(caps) if caps else bl - cap_target)
            cap_h = max(1.0, bl - cap)
            scale = cap_target / cap_h
            return bl, scale

        # bangun di dir SEMENTARA; workspace lama baru diganti bila build sukses (anti data-loss)
        tmp = self._fresh_root()
        gdir = tmp / "glyphs"
        gdir.mkdir(parents=True)
        names = {}
        used = 0
        n_kept = max(1, len(kept))
        for i, s in enumerate(kept):
            self._set_progress(2 + int(12 * i / n_kept), "Menormalkan glyph…")
            tok = (tokens[i] if i < len(tokens) else "").strip()
            if not tok:
                continue
            bl, scale = metrics_for(s["bbox"])
            fy = baseY - bl * scale  # raw_y*scale + fy → baseline raw bl jadi baseY
            paths_em = []
            for d in s["paths"]:
                sp = SVGPathPen(None)
                parse_path(d, TransformPen(sp, (scale, 0, 0, scale, 0, fy)))
                paths_em.append(sp.getCommands())
            x0 = s["bbox"][0] * scale
            x1 = s["bbox"][2] * scale
            W = round((x1 - x0) + 2 * margin)
            paths = "".join(f'<path fill-rule="evenodd" d="{d}"/>' for d in paths_em)
            stem = f"g{used:04d}"
            used += 1
            (gdir / f"{stem}.svg").write_text(
                f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0 - margin} 0 {W} {upm}">{paths}</svg>',
                encoding="utf-8")
            names[stem] = tok
        (gdir / "_names.json").write_text(json.dumps(names), encoding="utf-8")
        self._set_progress(15, "Membangun font…")
        # build_ufo melapor 0..1 → petakan ke 15..80% (tahap terberat: bersih kontur, spacing, kerning)
        self._build_ufo_at(gdir, tmp / "project.ufo", family, style, preset,
                           progress=lambda frac, label: self._set_progress(15 + int(65 * frac), label), fit_ink=True, zero_kern=True)
        self._swap_root(tmp)  # sukses → ganti workspace lama (staging lama ikut terhapus)
        meta = {"family": family, "style": style, "upm": 1000, "preset": preset, "layout": None,
                "rows": None, "masters": [{"value": None, "ufo": "project.ufo", "name": style}], "axis": None}
        self._save_meta(meta)
        self._set_progress(82, "Mengompilasi pratinjau…")
        self.compile_preview()
        self._set_progress(100, "Selesai", active=False)
        return self.state()

    @staticmethod
    def _split(spec, out_dir, layout, rows):
        lay = specimen_split.load_layout(layout) if layout else None
        rows_spec = tuple(r.strip() for r in (rows or "upper,lower").split(","))
        specimen_split.split(spec, out_dir, rows_spec=rows_spec, layout=lay)

    def _build_ufo_at(self, glyph_dir, ufo_path, family, style, preset, progress=None,
                      fit_ink=False, zero_kern=False):
        svgs = sorted(Path(glyph_dir).glob("*.svg"))
        smoke_test.build_ufo(svgs, ufo_path, upm=1000, baseline_ratio=0.8,
                             family=family, style=style, autospace=True, kern=True, preset=preset,
                             progress=progress)
        # Jalur IMPORT (pilihan user): mulai bersih agar mudah diatur —
        #   fit_ink  : batas kiri/kanan tiap glyph ke node terluar (LSB=RSB=0).
        #   zero_kern: SEMUA nilai kerning = 0 (grup/kelas bentuk TETAP → bisa diatur massal via "Kelas").
        # Re-seed/respace TIDAK memakai keduanya (tetap spacing preset + kerning seed).
        if fit_ink or zero_kern:
            f = ufoLib2.Font.open(ufo_path)
            changed = False
            if fit_ink and _fit_to_ink(f):
                changed = True
            if zero_kern and f.kerning:
                f.kerning.clear()  # nilai jadi 0; font.groups (kelas kern) sengaja DIPERTAHANKAN
                changed = True
            if changed:
                f.save(ufo_path, overwrite=True)

    # --- variable font: masters & axis ------------------------------------
    @_locked
    def set_axis(self, tag, name, vmin, vmax, vdefault):
        meta = self._meta()
        meta["axis"] = {"tag": tag, "name": name, "min": vmin, "max": vmax, "default": vdefault}
        # master 0 (project.ufo) duduk di lokasi default
        meta["masters"][0]["value"] = vdefault
        self._save_meta(meta)
        self.compile_preview()
        return self.state()

    @_locked
    def add_master(self, svg_bytes, value, *, style="Master"):
        meta = self._meta()
        if not meta.get("axis"):
            raise ValueError("Tetapkan axis dulu sebelum menambah master.")
        ax = meta["axis"]
        if not (ax["min"] <= value <= ax["max"]):
            raise ValueError(f"Nilai master {value} di luar rentang axis {ax['min']}–{ax['max']}.")
        if any(m.get("value") == value for m in meta["masters"]):
            raise ValueError(f"Sudah ada master di {ax['tag']}={value}.")
        idx = len(meta["masters"])
        mdir = self.root / "masters" / f"m{idx}"
        if mdir.exists():
            shutil.rmtree(mdir)
        mdir.mkdir(parents=True)
        spec = mdir / "_specimen.svg"
        spec.write_bytes(_to_svg_bytes(svg_bytes))  # terima SVG atau PDF
        gdir = mdir / "glyphs"
        gdir.mkdir()
        self._split(spec, gdir, meta.get("layout"), meta.get("rows"))
        ufo_rel = f"masters/m{idx}/master.ufo"
        self._build_ufo_at(gdir, self.root / ufo_rel, meta["family"], style, meta["preset"])
        meta["masters"].append({"value": value, "ufo": ufo_rel, "name": style})
        self._save_meta(meta)
        self.compile_preview()
        return self.state()

    def _is_variable(self, meta):
        return bool(meta.get("axis")) and len([m for m in meta.get("masters", []) if m.get("value") is not None]) >= 2

    def _build_vf(self, meta, out_dir, cff2=False):
        import variable
        axis = meta["axis"]
        masters = [(self.root / m["ufo"], m["value"], m.get("name", "Master"))
                   for m in meta["masters"] if m.get("value") is not None]
        # harmonisasi: glyph tak-kompatibel dibuat statis (laporkan di _static_glyphs)
        harm, static = variable.harmonize(masters, axis["default"], self.root / "_harmonized")
        self._static_glyphs = static
        ds = variable.build_designspace(harm, axis, self.root / "_project.designspace",
                                        family=meta.get("family", "Font"))
        return variable.compile_variable(ds, out_dir, cff2=cff2)  # dict {ttf, otf?}

    # --- preset / respace --------------------------------------------------
    @_locked
    def respace(self, preset=None):
        meta = self._meta()
        if preset:
            meta["preset"] = preset
            self._save_meta(meta)
        # re-seed semua master dari SVG-nya dgn preset baru
        self._build_ufo_at(self.glyph_dir, self.ufo_path, meta["family"], meta["masters"][0]["name"], meta["preset"])
        for m in meta["masters"][1:]:
            gdir = (self.root / m["ufo"]).parent / "glyphs"
            if gdir.exists():
                self._build_ufo_at(gdir, self.root / m["ufo"], meta["family"], m["name"], meta["preset"])
        self.compile_preview()
        return self.state()

    # --- edit metrik -------------------------------------------------------
    @_locked
    def fit_all(self, recompile=False):
        """Rapatkan sidebearing SEMUA glyph ke ink (LSB=0 & RSB=0) — batas kiri/kanan tiap glyph
        menempel ke node terluar. Logika di modul _fit_to_ink (juga dipakai otomatis saat import)."""
        font = self._font()
        total = len([n for n in font.glyphOrder if n != ".notdef" and n in font])
        fitted = _fit_to_ink(font)
        if fitted:
            font.save(self.ufo_path, overwrite=True)
            if recompile:
                self.compile_static()
        return {"fitted": fitted, "total": total, "skipped": total - fitted}

    @_locked
    def set_spacing(self, name, lsb=None, rsb=None, recompile=True):
        """recompile=False → hanya tulis UFO (cepat); webfont di-recompile terpisah (debounce di UI)."""
        font = self._font()
        g = font[name]
        b = g.getBounds(font)
        if b is None:
            return None
        cur_lsb = b.xMin
        cur_rsb = g.width - b.xMax
        new_lsb = cur_lsb if lsb is None else lsb
        new_rsb = cur_rsb if rsb is None else rsb
        # translasi posisi saja (PRD §9.4) — kontur + KOMPONEN + ANCHOR (glyph komposit ikut geser,
        # anchor tetap menempel; kalau hanya kontur, glyph komposit diam tapi width berubah = LSB rusak)
        dx = new_lsb - cur_lsb
        if dx:
            for c in g:
                for p in c:
                    p.x += dx
            for comp in g.components:
                t = list(comp.transformation)
                t[4] += dx
                comp.transformation = tuple(t)
            for a in g.anchors:
                a.x += dx
        g.width = round(b.xMax + dx + new_rsb)
        font.save(self.ufo_path, overwrite=True)
        if recompile:
            self.compile_static()  # cepat: cuma master 0 (edit terjadi di sini)
        return self._glyph_metrics(font, name)

    @_locked
    def set_metrics(self, ascender=None, descender=None, capHeight=None, xHeight=None, recompile=True):
        """Set metrik vertikal font (garis atas-bawah). Font-level (master 0)."""
        font = self._font()
        info = font.info
        if ascender is not None:
            info.ascender = round(ascender)
        if descender is not None:
            info.descender = round(descender)
        if capHeight is not None:
            info.capHeight = round(capHeight)
        if xHeight is not None:
            info.xHeight = round(xHeight)
        # sanity SEBELUM save: metrik rusak (asc ≤ 0 / desc > 0 / asc ≤ desc) membuat SEMUA compile
        # berikutnya gagal (project macet) — tolak di sini, UFO tak disentuh.
        if not ((info.ascender or 0) > 0 and (info.descender or 0) <= 0):
            raise ValueError("Metrik tak valid: ascender harus > 0 dan descender ≤ 0")
        font.save(self.ufo_path, overwrite=True)
        if recompile:
            self.compile_static()
        return {"ascender": info.ascender, "descender": info.descender,
                "capHeight": info.capHeight, "xHeight": info.xHeight}

    def glyphs_render(self):
        """Semua glyph (path kontur + advance + komponen ringkas) dalam SATU panggilan →
        mode Text bisa render seketika tanpa fetch per-huruf. Komponen tanpa basePath
        (frontend resolve dari peta yang sama)."""
        font = self._font()
        out = {}
        for n in font.glyphOrder:
            if n == ".notdef" or n not in font:
                continue
            g = font[n]
            out[n] = {
                "path": self._contour_path(g),
                "advance": round(g.width),
                "components": [{"base": c.baseGlyph, "transform": [round(t, 4) for t in c.transformation]} for c in g.components],
                # kontur terstruktur → mode Text bisa tampilkan node/handle & X-Ray (outline)
                "outline": [[{"x": round(p.x, 1), "y": round(p.y, 1),
                              "type": (p.type or "offcurve"), "smooth": bool(p.smooth)} for p in c] for c in g],
            }
        return {"glyphs": out}

    def kern_list(self, q=None, limit=400):
        """Pasangan kerning tersimpan (panel daftar). Kunci bisa glyph atau grup (public.kern1/2.*);
        tiap sisi diberi label + karakter contoh. FILTER via `q` (cocok label/char kiri/kanan) &
        LIMIT (font bisa punya puluhan ribu pasangan → jangan kirim/ render semuanya). |nilai| terbesar dulu."""
        font = self._font()
        uni = {n: (font[n].unicode if n in font else None) for n in font.glyphOrder}

        def rep(key):
            if key.startswith("public.kern1.") or key.startswith("public.kern2."):
                members = list(font.groups.get(key, []))
                u = uni.get(members[0]) if members else None
                return {"key": key, "isGroup": True,
                        "label": key.replace("public.kern1.", "").replace("public.kern2.", ""),
                        "char": chr(u) if u else None, "size": len(members)}
            u = uni.get(key)
            return {"key": key, "isGroup": False, "label": key, "char": chr(u) if u else None}

        needle = (q or "").strip().lower()
        matched = []
        for (l, r), v in font.kerning.items():
            L, R = rep(l), rep(r)
            if needle:
                hay = f"{L['label']} {R['label']} {L.get('char') or ''} {R.get('char') or ''}".lower()
                if needle not in hay:
                    continue
            matched.append({"left": L, "right": R, "value": int(v)})
        matched.sort(key=lambda p: (-abs(p["value"]), p["left"]["label"], p["right"]["label"]))
        return {"pairs": matched[:limit], "total": len(font.kerning), "matched": len(matched)}

    @staticmethod
    def _kern_groups(font):
        """Peta glyph → nama grup kern: g1 (sisi kiri, public.kern1.*), g2 (sisi kanan, public.kern2.*)."""
        g1, g2 = {}, {}
        for gname, members in font.groups.items():
            if gname.startswith("public.kern1."):
                for m in members:
                    g1[m] = gname
            elif gname.startswith("public.kern2."):
                for m in members:
                    g2[m] = gname
        return g1, g2

    def get_kern(self, left, right):
        font = self._font()
        g1, g2 = self._kern_groups(font)
        lg, rg = g1.get(left), g2.get(right)
        kern = font.kerning
        # resolusi UFO §9.6 (urutan ufo2ft): (L,R) > (L,grpR) > (grpL,R) > (grpL,grpR)
        # — glyph di sisi PERTAMA lebih spesifik; salah urutan → nilai yang dilaporkan UI beda
        # dgn yang benar-benar dipakai font hasil kompilasi.
        value = 0
        for k in [(left, right)] + ([(left, rg)] if rg else []) + ([(lg, right)] if lg else []) + ([(lg, rg)] if lg and rg else []):
            if k in kern:
                value = int(kern[k]); break
        # classValue = nilai pada kunci LEVEL-KELAS yang SAMA dgn yang ditulis set_kerning(scope='class'):
        # (grup bila ada, fallback glyph). Sebelumnya butuh lg&rg → glyph tanpa grup selalu None → nilai "hilang".
        cl, cr = lg or left, rg or right
        return {
            "left": left, "right": right, "value": value,
            "leftGroup": lg, "rightGroup": rg,
            "classValue": int(kern[(cl, cr)]) if (cl, cr) in kern else None,
            "pairValue": int(kern[(left, right)]) if (left, right) in kern else None,
        }

    def smart_kern(self, left, right):
        """Saran kern OPTIKAL (sadar-bentuk) untuk satu pasangan — TIDAK menulis apa pun.
        Menghitung dari geometri outline (bentuk lurus/bulat/menjorok/diagonal menyesuaikan).
        Frontend menampilkannya sbg nilai tertahan; ditulis hanya saat user klik Terapkan."""
        font = self._font()
        if left not in font or right not in font:
            raise ValueError(f"Glyph tidak dikenal: {left!r} / {right!r}")
        upm = font.info.unitsPerEm or 1000
        v = kerning_mod.smart_pair(font, left, right, upm=upm)
        return {"left": left, "right": right, "value": int(v)}

    @_locked
    def shift_all_kerning(self, delta, recompile=False):
        """Geser SEMUA nilai kerning tersimpan sebesar `delta` (em) — bake permanen, tanpa
        terkecuali (scope 'Semuanya' di UI). Nilai baru terlihat di daftar kerning & ikut export."""
        font = self._font()
        d = int(delta)
        if not d:
            return {"shifted": 0, "kerning": len(font.kerning)}
        for k in list(font.kerning.keys()):
            # round (bukan int→truncate) + clamp ke rentang GPOS int16 (fontmake menolak di luar itu)
            v = round(font.kerning[k]) + d
            font.kerning[k] = max(-32767, min(32767, v))
        font.save(self.ufo_path, overwrite=True)
        if recompile:
            self.compile_static()
        return {"shifted": len(font.kerning), "kerning": len(font.kerning)}

    @_locked
    def clear_all_kerning(self, recompile=False):
        """Nolkan SEMUA nilai kerning (font.kerning dikosongkan). Grup kelas (font.groups)
        SENGAJA dipertahankan → bisa langsung diatur massal lewat scope 'Kelas'. Konsisten dgn
        perilaku import (zero_kern). Untuk project yang sudah ada."""
        font = self._font()
        n = len(font.kerning)
        if n:
            font.kerning.clear()
            font.save(self.ufo_path, overwrite=True)
            if recompile:
                self.compile_static()
        return {"cleared": n}

    @_locked
    def auto_kern_all(self, only_empty=True, recompile=True):
        """Auto-kern optikal SELURUH pasangan huruf & angka (ASCII, glyph-level).
        only_empty=True (default) → HANYA mengisi pasangan yang belum punya kerning apa pun
        (glyph maupun lewat grup) → kerning manual/kelas yang sudah ada TIDAK ditimpa (aman)."""
        font = self._font()
        upm = font.info.unitsPerEm or 1000
        # Kandidat dibatasi ke huruf & angka ASCII (A–Z a–z 0–9) agar tak meledak (n²).
        # Varian aksen ikut lewat "Perluas kelas".
        names = []
        for n in font.glyphOrder:
            if n == ".notdef" or n not in font:
                continue
            u = font[n].unicode
            if u and (0x41 <= u <= 0x5A or 0x61 <= u <= 0x7A or 0x30 <= u <= 0x39):
                names.append(n)
        pairs = kerning_mod.auto_kern_pairs(font, names, upm=upm)
        g1, g2 = self._kern_groups(font)
        written = skipped = 0
        done = set()
        for (L, R), v in pairs.items():
            lg, rg = g1.get(L), g2.get(R)
            # tulis LEVEL KELAS bila glyph punya grup (konsisten set_kerning scope='class');
            # kalau ditulis per-glyph, pasangan itu jadi exception yang MEMBAYANGI edit kelas berikutnya.
            key = (lg or L, rg or R)
            if key in done:
                continue  # anggota grup lain sudah menulis kunci kelas yang sama (nilai ~identik)
            done.add(key)
            if only_empty:
                keys = [(L, R)] + ([(lg, R)] if lg else []) + ([(L, rg)] if rg else []) + ([(lg, rg)] if lg and rg else [])
                if any(k in font.kerning for k in keys):
                    skipped += 1
                    continue
            elif key != (L, R):
                # mode TIMPA: buang SEMUA exception yang lebih spesifik dari kunci kelas — bukan hanya
                # (L,R) tapi SETIAP anggota grup kiri×kanan + half-class (§9.6). Kalau tidak, exception
                # pada anggota lain (mis. Á V, sementara yang diproses A V) membayangi nilai kelas baru
                # → kern anggota itu tak ikut berubah. Ambil anggota dari font.groups, bukan cuma L/R.
                lefts = list(font.groups.get(lg, [])) if lg else [L]
                rights = list(font.groups.get(rg, [])) if rg else [R]
                for ml in lefts:
                    for mr in rights:
                        if (ml, mr) != key:
                            font.kerning.pop((ml, mr), None)        # per-glyph
                    if rg and (ml, rg) != key:
                        font.kerning.pop((ml, rg), None)            # half-class (anggotaKiri, grupKanan)
                if lg:
                    for mr in rights:
                        if (lg, mr) != key:
                            font.kerning.pop((lg, mr), None)        # half-class (grupKiri, anggotaKanan)
            font.kerning[key] = v
            written += 1
        if written:
            font.save(self.ufo_path, overwrite=True)
            if recompile:
                self.compile_static()
        return {"candidates": len(names), "computed": len(pairs), "written": written, "skipped": skipped}

    @_locked
    def expand_kern_groups(self):
        """Gabungkan varian aksen ke kelas kern huruf dasarnya (À,Á,Â… → kelas A, sisi kiri & kanan)
        via dekomposisi Unicode NFD. Kerning di-rekey (nilai DASAR menang). §9.6 (level kelas)."""
        import unicodedata
        font = self._font()
        char2name = {chr(font[n].unicode): n for n in font.glyphOrder if n in font and font[n].unicode}

        def base_name(n):
            u = font[n].unicode if n in font else None
            if not u:
                return None
            c = chr(u)
            d = unicodedata.normalize("NFD", c)
            if d and d[0] != c and unicodedata.category(d[0]).startswith("L"):
                return char2name.get(d[0])
            return None

        repl = {}  # glyph varian → glyph dasar (yang ada & beda)
        for n in list(font.glyphOrder):
            b = base_name(n)
            if b and b != n:
                repl[n] = b
        if not repl:
            return {"merged": 0, "variants": 0}
        g1, g2 = self._kern_groups(font)
        groups = {k: list(v) for k, v in font.groups.items()}
        rename, merged = {}, 0
        for gmap, pfx in [(g1, "public.kern1."), (g2, "public.kern2.")]:
            for v, b in repl.items():
                vg = gmap.get(v)
                bg = gmap.get(b) or (pfx + b)
                if bg not in groups:
                    groups[bg] = [b]
                if vg == bg:
                    continue
                if v not in groups[bg]:
                    groups[bg].append(v); merged += 1
                if vg is not None:
                    groups[vg] = [m for m in groups[vg] if m != v]
                    if not groups[vg]:
                        rename[vg] = bg; del groups[vg]
        # rekey kerning: pasangan DASAR (tanpa rename) menang atas varian
        items = list(font.kerning.items())
        nk = {}
        for (L, R), val in items:
            if L not in rename and R not in rename:
                nk[(L, R)] = val
        for (L, R), val in items:
            if L in rename or R in rename:
                k = (rename.get(L, L), rename.get(R, R))
                if k not in nk:
                    nk[k] = val
        font.groups = groups
        font.kerning = nk
        font.save(self.ufo_path, overwrite=True)
        self.compile_static()
        return {"merged": merged, "variants": len(repl), "groups": len(groups), "kerning": len(nk)}

    @_locked
    def set_kerning(self, left, right, value, scope="class", recompile=True):
        """scope='class' → tulis di level GRUP (semua glyph se-kelas ikut, §9.6); 'pair' → kecuali (exception).
        recompile=False → HANYA tulis nilai (cepat, tanpa compile webfont). Dipakai saat menyetel live;
        preview canvas/panel baca dari path+nilai (tak butuh webfont). Recompile webfont dijadwalkan terpisah."""
        font = self._font()
        if left not in font or right not in font:
            raise ValueError(f"Glyph tidak dikenal: {left!r} / {right!r}")
        g1, g2 = self._kern_groups(font)
        lg, rg = g1.get(left), g2.get(right)
        if scope == "class":
            l, r = lg or left, rg or right  # pakai grup bila ada, fallback glyph
        else:
            l, r = left, right
        # clamp ke rentang int16 GPOS (±32767) + bulatkan — nilai di luar rentang membuat
        # compile fontmake/otlLib GAGAL permanen (preview diam-diam berhenti, export 400).
        # Konsisten dgn shift_all_kerning yang juga meng-clamp.
        v = max(-32767, min(32767, round(float(value))))
        if v == 0:
            if scope == "pair":
                # exception-ke-0 klasik: bila level KELAS ≠ 0, tulis (glyph,glyph)=0 eksplisit —
                # kalau kuncinya di-pop, nilai kelas muncul lagi (nilai "tak mau nol").
                cls = 0
                # urutan §9.6 yang sama dgn get_kern: (L,grpR) > (grpL,R) > (grpL,grpR)
                for k in ([(left, rg)] if rg else []) + ([(lg, right)] if lg else []) + ([(lg, rg)] if lg and rg else []):
                    if k in font.kerning:
                        cls = int(font.kerning[k])
                        break
                if cls != 0:
                    font.kerning[(l, r)] = 0
                else:
                    font.kerning.pop((l, r), None)
            else:
                font.kerning.pop((l, r), None)
        else:
            font.kerning[(l, r)] = v
        font.save(self.ufo_path, overwrite=True)
        if recompile:
            self.compile_static()
        return self.get_kern(left, right)

    @_locked
    def fix_missing_unicodes(self):
        """Perbaikan data: glyph bernama karakter tunggal tapi TANPA unicode (mis. '_' dari bug
        penamaan lama) → cmap bolong, karakternya tak bisa diketik & grid pakai fallback dot.
        Assign ord(nama) lalu recompile. Aman diulang (idempoten)."""
        font = self._font()
        fixed = []
        for g in font:
            if g.unicode is None and g.name and len(g.name) == 1:
                g.unicode = ord(g.name)
                fixed.append(g.name)
        if fixed:
            font.save(self.ufo_path, overwrite=True)
            self.compile_static()
        return {"fixed": fixed}

    @_locked
    def recompile_preview(self):
        """Recompile webfont preview (dipanggil setelah rentetan tulisan kern 'cepat' → grid & PreviewBar mutakhir)."""
        self.compile_static()
        return {"version": self._version}

    @_locked
    def set_metadata(self, data):
        font = self._font()
        info = font.info
        meta = self._meta()
        if "family" in data:
            info.familyName = info.styleMapFamilyName = data["family"]
            meta["family"] = data["family"]
        if "style" in data:
            info.styleName = data["style"]
            meta["style"] = data["style"]
        if "version" in data and data["version"]:
            try:
                maj, _, mnr = str(data["version"]).partition(".")
                info.versionMajor = int(maj or 1)
                info.versionMinor = int(mnr or 0)
            except ValueError:
                pass
        for key, attr in _META_FIELDS.items():
            if key in data:
                setattr(info, attr, data[key] or None)
        meta["metadata"] = {**meta.get("metadata", {}),
                            **{k: data[k] for k in (set(_META_FIELDS) | {"version"}) if k in data}}
        font.save(self.ufo_path, overwrite=True)
        self._save_meta(meta)
        self.compile_preview()
        return self.state()

    # --- compile -----------------------------------------------------------
    @_locked
    def compile_static(self):
        """Preview cepat dari master 0 saja (static OTF→woff2). Untuk feedback edit.

        Catatan: pada project VF, preview jadi statis (master default) setelah edit; VF
        penuh dibangun ulang saat ganti axis/master/preset atau export."""
        prev = self.root / "_preview"
        if prev.exists():
            shutil.rmtree(prev)
        otf, _ = smoke_test.compile_with_fontmake(self.ufo_path, prev)
        web = smoke_test.wrap_web(otf, prev)
        shutil.copy(web["woff2"], self.preview)
        self._version = int(time.time() * 1000)
        return self._version

    @_locked
    def compile_preview(self):
        meta = self._meta()
        prev = self.root / "_preview"
        if prev.exists():
            shutil.rmtree(prev)
        if self._is_variable(meta):
            vf = self._build_vf(meta, prev)["ttf"]
            from fontTools.ttLib import TTFont
            tt = TTFont(vf)
            tt.flavor = "woff2"
            tt.save(self.preview)
        else:
            otf, _ttf = smoke_test.compile_with_fontmake(self.ufo_path, prev)
            web = smoke_test.wrap_web(otf, prev)
            shutil.copy(web["woff2"], self.preview)
        self._version = int(time.time() * 1000)
        return self._version

    @_locked
    def set_tracking(self, value):
        """Tracking GLOBAL (em): spasi seragam berlapis di atas kerning. Disimpan di meta (TIDAK
        mengubah advance UFO → non-destruktif). Preview live via CSS/SVG; di-bake ke advance saat export."""
        meta = self._meta()
        meta["tracking"] = int(value)
        self._save_meta(meta)
        return self.state()

    def _tracked_ufo(self, src, tracking):
        """Salinan UFO dengan tracking di-tambahkan ke advance tiap glyph (untuk export). src tak diubah."""
        if not tracking:
            return src
        font = ufoLib2.Font.open(src)
        for g in font:
            if g.name != ".notdef":
                # clamp ≥0: tracking negatif pada glyph sempit bisa membuat advance negatif →
                # fontmake menolak ("width should not be negative") → SELURUH export gagal.
                g.width = max(0, round(g.width + tracking))
        dst = Path(src).parent / (Path(src).stem + "_trk.ufo")
        if dst.exists():
            shutil.rmtree(dst)
        font.save(dst, overwrite=True)
        return dst

    @_locked  # menulis _export & (dgn tracking) *_trk.ufo di workspace → serialkan dgn save lain
    def export_zip(self):
        out = self.root / "_export"
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        meta = self._meta()
        tracking = int(meta.get("tracking", 0))
        base = f"{meta.get('family','Font').replace(' ', '')}-{meta.get('style','Regular').replace(' ', '')}"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            if self._is_variable(meta):
                from fontTools.ttLib import TTFont
                vmeta = meta
                if tracking:  # bake tracking ke tiap master
                    vmeta = json.loads(json.dumps(meta))
                    for m in vmeta["masters"]:
                        td = self._tracked_ufo(self.root / m["ufo"], tracking)
                        m["ufo"] = str(Path(td).relative_to(self.root))
                res = self._build_vf(vmeta, out, cff2=True)  # {ttf, otf?}
                ttf = res["ttf"]
                z.write(ttf, f"{base}-VF.ttf")
                if res.get("otf"):
                    z.write(res["otf"], f"{base}-VF.otf")  # CFF2 VF
                for flavor in ("woff", "woff2"):
                    tt = TTFont(ttf)
                    tt.flavor = flavor
                    wp = out / f"vf.{flavor}"
                    tt.save(wp)
                    z.write(wp, f"{base}-VF.{flavor}")
            else:
                otf, ttf = smoke_test.compile_with_fontmake(self._tracked_ufo(self.ufo_path, tracking), out)
                web = smoke_test.wrap_web(otf, out)
                for f in (otf, ttf, web["woff"], web["woff2"]):
                    z.write(f, f"{base}{f.suffix}")
        buf.seek(0)
        return buf, f"{base}.zip"

    # --- read --------------------------------------------------------------
    def _glyph_metrics(self, font, name):
        g = font[name]
        b = g.getBounds(font)
        cp = g.unicode
        return {
            "name": name,
            "unicode": cp,
            "char": chr(cp) if cp else None,
            "advance": round(g.width),
            "lsb": round(b.xMin) if b else 0,
            "rsb": round(g.width - b.xMax) if b else 0,
            "contours": len(g.contours),
            "category": _category(name, cp),
            "empty": b is None,
        }

    @staticmethod
    def _contour_path(g):
        # path KONTUR-saja (komponen di-skip → hindari crash SVGPathPen yg butuh glyphSet)
        pen = SVGPathPen(None)
        for c in g:
            c.draw(pen)
        return pen.getCommands()

    def glyph_svg(self, name):
        font = self._font()
        g = font[name]
        info = font.info
        asc = info.ascender or 800
        desc = info.descender or -200
        # kontur terstruktur (untuk editor node): titik on/off-curve per kontur
        contours = []
        for c in g:
            pts = [{"x": round(p.x, 1), "y": round(p.y, 1),
                    "type": (p.type or "offcurve"), "smooth": bool(p.smooth)} for p in c]
            contours.append(pts)
        comps = []
        for comp in g.components:
            bp, bb = "", None
            if comp.baseGlyph in font:
                bg = font[comp.baseGlyph]
                bp = self._contour_path(bg)
                bnd = bg.getBounds(font)
                bb = [round(bnd.xMin), round(bnd.yMin), round(bnd.xMax), round(bnd.yMax)] if bnd else None
            comps.append({"base": comp.baseGlyph, "transform": [round(t, 4) for t in comp.transformation], "basePath": bp, "baseBounds": bb})
        return {
            "path": self._contour_path(g),
            "advance": round(g.width),
            "ascender": asc,
            "descender": desc,
            "capHeight": info.capHeight or round(asc * 0.875),
            "xHeight": info.xHeight or round(asc * 0.625),
            "upm": info.unitsPerEm or 1000,
            **self._glyph_metrics(font, name),
            "outline": contours,
            "anchors": [{"name": a.name or "", "x": round(a.x, 1), "y": round(a.y, 1)} for a in g.anchors],
            "components": comps,
        }

    @_locked
    def set_outline(self, name, contours, recompile=True):
        """Tulis ulang kontur glyph dari titik (editor node). PRD §9.4 longgar:
        node ditulis ke UFO lalu di-recompile → preview tetap = final.
        recompile=False → hanya tulis (cepat, ~10× lebih ringan); webfont menyusul (debounce UI)."""
        font = self._font()
        g = font[name]
        g.clearContours()
        pen = g.getPointPen()
        for c in contours:
            if not c:
                continue
            pen.beginPath()
            for p in c:
                st = None if p.get("type") == "offcurve" else p.get("type")
                pen.addPoint((p["x"], p["y"]), segmentType=st, smooth=bool(p.get("smooth")))
            pen.endPath()
        font.save(self.ufo_path, overwrite=True)
        if recompile:
            self.compile_static()
        return self.glyph_svg(name)

    def simplify_glyph(self, name, tolerance=3.0, recompile=False):
        """Rapikan node/handle glyph: hapus titik yang tak dibutuhkan TANPA merusak bentuk
        (toleransi = simpangan maks, unit em). Algoritma di engine/simplify.py; penulisan
        via set_outline (ter-lock, respons sama dgn editor node → UI langsung sinkron)."""
        font = self._font()
        if name not in font:
            raise KeyError(name)
        g = font[name]
        contours = [[{"x": p.x, "y": p.y, "type": (p.type or "offcurve"), "smooth": bool(p.smooth)}
                     for p in c] for c in g]
        slim = simplify_mod.simplify_contours(contours, tolerance=float(tolerance))
        return self.set_outline(name, slim, recompile=recompile)

    @_locked
    def set_components(self, name, components, recompile=True):
        """Tulis ulang komponen glyph (referensi ke glyph lain + transform). Mengubah bentuk
        terkomposisi → recompile (preview = final)."""
        from ufoLib2.objects import Component
        font = self._font()
        g = font[name]
        g.clearComponents()
        for c in components:
            base = c["base"]
            if base not in font:
                raise ValueError(f"Glyph basis '{base}' tidak ada")
            t = c.get("transform") or [1, 0, 0, 1, 0, 0]
            g.components.append(Component(baseGlyph=base, transformation=tuple(float(v) for v in t)))
        font.save(self.ufo_path, overwrite=True)
        if recompile:
            self.compile_static()
        return self.glyph_svg(name)

    @_locked
    def set_anchors(self, name, anchors):
        """Tulis ulang anchor glyph (titik bernama utk attachment mark). Tak mengubah outline →
        tak perlu recompile (bentuk glyph sama)."""
        font = self._font()
        g = font[name]
        del g.anchors[:]
        for a in anchors:
            g.appendAnchor({"x": round(a["x"]), "y": round(a["y"]), "name": (a.get("name") or "").strip()})
        font.save(self.ufo_path, overwrite=True)
        return self.glyph_svg(name)

    def state(self):
        if not self.exists:
            return {"empty": True}
        font = self._font()
        meta = self._meta()
        glyphs = [self._glyph_metrics(font, n) for n in font.glyphOrder if n != ".notdef" and n in font]
        glyphs.sort(key=lambda x: (x["unicode"] is None, x["unicode"] or 0))
        # kerning + groups
        groups = {k: list(v) for k, v in font.groups.items()}
        # NB: daftar kerning (bisa puluhan ribu) TIDAK dikirim di payload — lookup on-demand
        # via GET /api/kerning?left=&right= (perf).
        return {
            "empty": False,
            "family": meta.get("family"),
            "style": meta.get("style"),
            "upm": meta.get("upm", 1000),
            "preset": meta.get("preset"),
            "tracking": int(meta.get("tracking", 0)),  # spasi global (em); berlapis di atas kerning
            "metadata": meta.get("metadata", {}),
            "glyphs": glyphs,
            "groups": groups,
            "kerningCount": len(font.kerning),
            "features": features_mod.summary(font),
            "axis": meta.get("axis"),
            "masters": meta.get("masters", []),
            "variable": self._is_variable(meta),
            "staticGlyphs": self._static_glyphs if self._is_variable(meta) else [],
            "presets": list(presets_mod.load().get("presets", {}).keys()),
            "version": self._version,
        }


_ID_RE = _re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ProjectLibrary:
    """Pustaka project lokal (device-per-user): tiap project = subdir berisi project.ufo +
    project.json + preview.woff2 (sama seperti satu workspace). Project aktif dipilih dari sini;
    instance `project` di-rebind ke dir-nya."""

    def __init__(self, root=PROJECTS_ROOT, legacy=WORKSPACE):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._active = None
        self._op_lock = threading.RLock()  # serialkan create/open/delete (cegah balapan id/rebind)
        self._migrate_legacy(Path(legacy))

    def _migrate_legacy(self, legacy):
        # Pustaka kosong tapi ada workspace lama berisi font → SALIN jadi 'default' (non-destruktif:
        # workspace lama tetap ada sebagai cadangan). Salin ke dir sementara lalu rename (anti-parsial).
        if not self._dirs() and (legacy / "project.ufo").exists():
            tmp = self.root / "_default_importing"
            if tmp.exists():
                shutil.rmtree(tmp)
            shutil.copytree(legacy, tmp, ignore=shutil.ignore_patterns(
                "_preview", "_export", "_harmonized", "*_new", "_stage.svg", "_staging.json"))
            tmp.rename(self.root / "default")

    def _dirs(self):
        if not self.root.exists():
            return []
        return [d for d in sorted(self.root.iterdir())
                if d.is_dir() and not d.name.startswith("_") and (d / "project.ufo").exists()]

    def _safe(self, pid):
        if not _ID_RE.match(pid or ""):
            raise ValueError(f"ID project tidak valid: {pid!r}")
        return self.root / pid

    def list(self):
        out = []
        for d in self._dirs():
            meta = {}
            mp = d / "project.json"
            if mp.exists():
                try:
                    meta = json.loads(mp.read_text())
                except (ValueError, OSError):
                    meta = {}
            gdir = d / "glyphs"
            gc = len(list(gdir.glob("*.svg"))) if gdir.exists() else None
            out.append({
                "id": d.name,
                "family": meta.get("family") or d.name,
                "style": meta.get("style"),
                "preset": meta.get("preset"),
                "glyphCount": gc,
                "updatedAt": int((d / "project.ufo").stat().st_mtime * 1000),
                "active": d.name == self._active,
            })
        out.sort(key=lambda x: x["updatedAt"], reverse=True)
        return out

    def _new_id(self, family):
        base = _re.sub(r"[^A-Za-z0-9_-]", "-", (family or "project").strip()).strip("-")[:40] or "project"
        existing = {p.name for p in self.root.iterdir() if p.is_dir()} if self.root.exists() else set()
        cand, n = base, 2
        while cand in existing:
            cand = f"{base}-{n}"; n += 1
        return cand

    def create(self, family="Untitled", style="Regular"):
        """Buat project kosong + aktifkan. ImportWizard mengisi font-nya (menulis project.ufo)."""
        with self._op_lock:  # _new_id + mkdir atomik → dua create bersamaan tak bentrok id
            pid = self._new_id(family)
            d = self.root / pid
            d.mkdir(parents=True)
            (d / "project.json").write_text(json.dumps(
                {"family": family, "style": style, "preset": "display-serif"}, indent=2))
            self.open(pid)
            return pid

    def open(self, pid):
        with self._op_lock:
            d = self._safe(pid)
            if not d.exists():
                raise KeyError(pid)
            project.rebind(d)
            self._active = pid
            (self.root / ".active").write_text(pid)
            return pid

    def delete(self, pid):
        with self._op_lock:
            d = self._safe(pid)
            if d.exists():
                shutil.rmtree(d)
            if self._active == pid:
                self._active = None
                dirs = self._dirs()
                if dirs:  # aktifkan project TERBARU yang tersisa
                    self.open(max(dirs, key=lambda p: (p / "project.ufo").stat().st_mtime).name)
            return self.list()

    def restore_active(self):
        """Bind `project` ke project aktif terakhir (.active) / terbaru saat start."""
        act = None
        af = self.root / ".active"
        if af.exists():
            cand = af.read_text().strip()
            if _ID_RE.match(cand or "") and (self.root / cand / "project.ufo").exists():
                act = cand
        if act is None:
            dirs = self._dirs()
            if dirs:
                act = max(dirs, key=lambda p: (p / "project.ufo").stat().st_mtime).name
        if act:
            self.open(act)
        return act


project = Project()
try:
    library = ProjectLibrary()
    library.restore_active()
except Exception as _e:  # noqa: BLE001 — state pustaka korup TIDAK boleh menggagalkan boot server
    import logging
    logging.getLogger("uvicorn.error").error("ProjectLibrary gagal inisialisasi: %s", _e)
    library = ProjectLibrary.__new__(ProjectLibrary)
    library.root = PROJECTS_ROOT
    library._active = None
    library._op_lock = threading.RLock()
