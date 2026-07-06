#!/usr/bin/env python3
"""
Sensatype Font Tool — Fase 1 Engine Smoke Test (headless CLI)

Pipeline (PRD §5):  SVG  ->  geometri bersih  ->  UFO  ->  fontmake  ->  OTF/TTF  ->  fontTools  ->  WOFF/WOFF2

Tujuan: membuktikan bagian paling berisiko (impor-bersihkan-geometri + ekspor)
tanpa UI apa pun. Lihat PRD §11 untuk kriteria lolos.

Aturan korektness yang diterapkan (PRD §9):
  1. Geometri dibersihkan SEKALI di sini saat impor.
  2. SVG (Y-down, sering even-odd)  ->  Font (Y-up, nonzero winding).
     picosvg.topicosvg() menormalkan winding even-odd -> nonzero (arah hole dibalik).
  3. skia-pathops.simplify() membuang overlap + mempertahankan winding (counter tetap berlubang).
  5. Semua nilai dalam unit em (UPM), bukan piksel.

Konvensi koordinat SVG -> em (default, bisa diubah lewat flag):
  - viewBox tinggi  -> UPM (mis. 1000).
  - Baseline berada di `baseline-ratio` dari ATAS viewBox (default 0.80 -> sisa 20% untuk descender).
  - Lebar viewBox  -> advance width (artboard = advance; LSB/RSB ada di dalam artwork). a la Fontself.

Penamaan file SVG -> glyph/Unicode:
  - "A.svg" / "a.svg" / "5.svg"      -> glyph ASCII, unicode = ord(char)
  - "uni0041.svg" / "u1E00.svg"      -> codepoint hex eksplisit
  - lainnya ("yoruna-x.svg")         -> nama glyph custom, auto-assign PUA (0xE000+) supaya tetap bisa diketik

Pemakaian:
  python engine/smoke_test.py --input svg --out build
  python engine/smoke_test.py --input svg --out build --upm 1000 --baseline-ratio 0.8 \
      --family "Yoruna Smoke" --style Regular
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path as FsPath

# --- font / svg libs ---------------------------------------------------------
import pathops
import ufoLib2
from fontTools.pens.qu2cuPen import Qu2CuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path as svg_parse_path
from fontTools.ttLib import TTFont
from picosvg.svg import SVG


# ---------------------------------------------------------------------------
# 1. SVG -> kontur skia bersih (impor + bersihkan geometri)
# ---------------------------------------------------------------------------
def svg_to_clean_skia(svg_file: FsPath, upm: int, baseline_ratio: float):
    """Baca satu SVG, normalisasi, petakan ke em, bersihkan overlap/winding.

    Mengembalikan (skia_path_bersih, advance_width, viewbox).
    """
    # Sanitasi export dunia nyata (Illustrator/Affinity): buang satuan "px"/"pt" pada
    # nilai numerik yang bikin picosvg gagal (mis. stroke-width:3px).
    raw = svg_file.read_text(encoding="utf-8")
    raw = re.sub(r"(?<=[\d.])(px|pt)\b", "", raw)
    # drop_unsupported: buang elemen non-outline (text/image) yang tak boleh ada di SVG glyph.
    svg = SVG.fromstring(raw).topicosvg(drop_unsupported=True)  # resolve transform + winding even-odd->nonzero
    vb = svg.view_box()
    if vb is None:
        raise ValueError(f"{svg_file.name}: tidak ada viewBox — wajib ada untuk pemetaan em.")
    minx, miny, w, h = vb
    if h == 0 or w == 0:
        raise ValueError(f"{svg_file.name}: viewBox punya lebar/tinggi 0.")

    scale = upm / h
    baseline_svg = miny + h * baseline_ratio
    # TransformPen affine: x' = sx*x + dx ; y' = sy*y + dy   (Y-flip via sy negatif)
    affine = (scale, 0.0, 0.0, -scale, -minx * scale, baseline_svg * scale)

    # Gambar SEMUA subpath ke satu skia Path lewat TransformPen.
    skpath = pathops.Path()
    sk_pen = skpath.getPen()
    trans_pen = TransformPen(sk_pen, affine)
    n_shapes = 0
    for shape in svg.shapes():
        d = getattr(shape, "d", None)
        if not d:
            continue
        svg_parse_path(d, trans_pen)
        n_shapes += 1
    if n_shapes == 0:
        raise ValueError(f"{svg_file.name}: tidak ada <path> setelah normalisasi.")

    # Bersihkan: buang overlap + perbaiki winding (counter tetap berlubang).
    # Fallback: kalau simplify gagal (input patologis sangat kompleks), pakai path hasil
    # normalisasi picosvg apa adanya — winding sudah benar, hanya overlap tak terbuang.
    try:
        skpath.simplify(fix_winding=True, keep_starting_points=False)
    except pathops.PathOpsError as e:
        print(f"  ⚠ {svg_file.name}: skia simplify gagal ({e}); pakai outline ternormalisasi tanpa buang overlap.",
              file=sys.stderr)

    advance = round(w * scale)
    return skpath, advance, (minx, miny, w, h)


# ---------------------------------------------------------------------------
# 2. Penamaan file -> (glyph name, unicode)
# ---------------------------------------------------------------------------
_RE_UNI = re.compile(r"^uni([0-9A-Fa-f]{4})$")
_RE_U = re.compile(r"^u([0-9A-Fa-f]{4,6})$")


def _agl_name(cp: int):
    """Nama glyph AGL untuk codepoint (mis. 0x41->'A', 0x61->'a'), atau None."""
    try:
        from fontTools import agl
        return agl.UV2AGL.get(cp)
    except Exception:
        return None


def _agl_to_uv(name: str):
    """Codepoint dari nama glyph AGL (mis. 'Aacute'->0x00C1), atau None."""
    try:
        from fontTools import agl
        return agl.AGL2UV.get(name)
    except Exception:
        return None


def name_and_codepoint(stem: str, pua_counter: list[int]):
    """Tentukan (nama glyph, codepoint|None) dari nama file (tanpa ekstensi).

    Aturan penamaan:
      uni0041 / u1E00      -> codepoint hex (dipetakan ke nama AGL: uni0041->A)
      A.ss01 / a.salt / g.alt -> ALTERNATE (ada titik) -> tanpa unicode
      f_i / f_f_i          -> LIGATURE (ada underscore) -> tanpa unicode
      Aacute / eacute / ntilde -> nama AGL (MULTILINGUAL precomposed) -> unicode dari AGL
      A / a / 5            -> karakter tunggal -> unicode = ord
      lainnya              -> nama custom -> PUA auto (supaya tetap bisa diketik)
    """
    m = _RE_UNI.match(stem) or _RE_U.match(stem)
    if m:
        cp = int(m.group(1), 16)
        return _agl_name(cp) or stem, cp
    # ALTERNATE: base.suffix (ss01, salt, alt, sups, dst.) -> tanpa cmap
    if "." in stem and stem.split(".", 1)[0]:
        return re.sub(r"[^A-Za-z0-9_.]", "_", stem), None
    # LIGATURE: komponen disambung underscore -> tanpa cmap.
    # Syarat SEMUA komponen non-kosong: glyph "_" (underscore sendiri) BUKAN ligatur —
    # jatuh ke cabang karakter tunggal (unicode 0x5F, nama AGL "underscore").
    if "_" in stem and all(stem.split("_")):
        return re.sub(r"[^A-Za-z0-9_.]", "_", stem), None
    # MULTILINGUAL / glyph bernama AGL (Aacute, eacute, ...) -> unicode
    uv = _agl_to_uv(stem)
    if uv is not None and len(stem) > 1:
        return stem, uv
    if len(stem) == 1:
        cp = ord(stem)
        # pakai nama AGL bila ada ('A'->A, '0'->zero, '.'->period) agar konsisten dgn preset
        return _agl_name(cp) or (stem if stem.isascii() and stem.isalnum() else f"uni{cp:04X}"), cp
    # Nama custom (mis. glyph Yoruna) -> auto-assign PUA supaya tetap bisa diketik.
    safe = re.sub(r"[^A-Za-z0-9_.]", "_", stem)
    cp = pua_counter[0]
    pua_counter[0] += 1
    return safe, cp


# ---------------------------------------------------------------------------
# 3. Bangun UFO
# ---------------------------------------------------------------------------
def build_ufo(svg_files, ufo_path: FsPath, *, upm, baseline_ratio, family, style,
              autospace=False, htls_area=400.0, htls_depth=15.0, htls_over=0.0,
              reference=None, xheight=None, preset=None, features=True,
              kern=False, kern_reference="n", kern_target=None, kern_deadband=8,
              progress=None):
    def _p(frac, label):
        if progress:
            try: progress(frac, label)
            except Exception: pass
    _p(0.0, "Menyiapkan…")
    font = ufoLib2.Font()
    info = font.info
    info.familyName = family
    info.styleName = style
    info.styleMapFamilyName = family
    info.styleMapStyleName = style.lower() if style.lower() in {"regular", "bold", "italic", "bold italic"} else "regular"
    info.unitsPerEm = upm
    top = round(upm * baseline_ratio)
    info.ascender = top
    info.descender = top - upm
    info.capHeight = round(top * 0.875)
    info.xHeight = round(top * 0.625)
    info.versionMajor = 1
    info.versionMinor = 0
    info.openTypeOS2VendorID = "SENS"

    # .notdef sederhana (kotak) supaya font valid & terlihat kalau glyph hilang.
    notdef = font.newGlyph(".notdef")
    notdef.width = round(upm * 0.5)
    npen = notdef.getPen()
    m = round(upm * 0.05)
    npen.moveTo((m, 0)); npen.lineTo((m, top)); npen.lineTo((notdef.width - m, top)); npen.lineTo((notdef.width - m, 0)); npen.closePath()

    pua = [0xE000]
    report = []
    glyph_order = [".notdef"]
    # sidecar opsional dari specimen_split: {stem_file: nama_glyph} utk alt/liga/multilingual
    names_map = {}
    if svg_files:
        sidecar = svg_files[0].parent / "_names.json"
        if sidecar.exists():
            import json as _json
            names_map = _json.loads(sidecar.read_text())
    _nfiles = max(1, len(svg_files))
    for _gi, svg_file in enumerate(svg_files):
        stem = svg_file.stem
        gname, cp = name_and_codepoint(names_map.get(stem, stem), pua)
        skpath, advance, vb = svg_to_clean_skia(svg_file, upm, baseline_ratio)

        glyph = font.newGlyph(gname)
        glyph.width = advance
        if cp is not None:
            glyph.unicode = cp
        # Tulis kontur bersih ke .glif. skia-pathops kadang menghasilkan segmen QUADRATIC;
        # CFF/OTF hanya mendukung cubic, jadi konversi quad->cubic (lossless) via Qu2CuPen.
        skpath.draw(Qu2CuPen(glyph.getPen(), max_err=0.6, all_cubic=True))

        n_contours = len(glyph.contours)
        bounds = glyph.getBounds(font)
        report.append({
            "file": svg_file.name, "glyph": gname, "unicode": cp,
            "advance": advance, "contours": n_contours, "bounds": bounds,
            "pua": cp is not None and cp >= 0xE000 and not (_RE_UNI.match(stem) or _RE_U.match(stem)),
        })
        glyph_order.append(gname)
        _p(0.60 * (_gi + 1) / _nfiles, "Membersihkan kontur…")

    # Preset (slot D6): parameter HTLS + reference per kategori.
    preset_data = None
    if preset:
        import presets
        pname, preset_data = presets.get_preset(preset)
        h = preset_data.get("htls", {})
        htls_area = h.get("area", htls_area)
        htls_depth = h.get("depth", htls_depth)
        htls_over = h.get("over", htls_over)
        kd = preset_data.get("kern", {}).get("deadband")
        if kd is not None:
            kern_deadband = kd

    # Auto-spacing seed (HT Letterspacer). CONTEXT D7: auto seed, manual memutuskan.
    _p(0.62, "Auto-spacing…")
    if autospace:
        import htls
        if preset:
            import presets
        xh = xheight if xheight else (font.info.xHeight or round(upm * 0.5))
        eng = htls.HTLS(upm=upm, xheight=xh, area=htls_area, depth=htls_depth, over=htls_over)
        # cache reference contours per nama glyph
        ref_cache = {}

        def _ref_contours_for(r):
            ref_name = None
            if preset_data:  # reference per kategori
                ref_name = presets.reference_for(preset_data, presets.category_of(r["unicode"]))
            if not ref_name:
                ref_name = reference  # override global / None=self
            if ref_name and ref_name in font:
                if ref_name not in ref_cache:
                    ref_cache[ref_name] = htls._flatten(font[ref_name])
                return ref_cache[ref_name]
            return None

        for r in report:
            g = font[r["glyph"]]
            b = g.getBounds(font)
            r["old_lsb"] = round(b.xMin) if b else 0
            r["old_rsb"] = round(g.width - b.xMax) if b else 0
            sb = eng.sidebearings(g, reference_contours=_ref_contours_for(r))
            if sb is None:
                r["new_lsb"] = r["new_rsb"] = None
                continue
            nL, nR = sb
            htls.apply_sidebearings(g, font, nL, nR)
            r["new_lsb"], r["new_rsb"] = nL, nR
            r["advance"] = g.width

    # Seed kerning Tier-1 (class-level). Jalan SETELAH spacing (butuh advance final).
    _p(0.84, "Menyusun kerning…")
    kern_info = None
    if kern:
        import kerning
        gnames = [r["glyph"] for r in report]
        kern_info = kerning.build_kerning(
            font, gnames, upm=upm, reference=kern_reference,
            target=kern_target, deadband=kern_deadband)

    # Fitur OpenType (liga/alt/aalt) dari konvensi nama glyph (PRD D5: auto-generate).
    if features:
        import features as feat_mod
        font.features.text = feat_mod.generate(font)

    font.glyphOrder = glyph_order
    _p(0.96, "Menyimpan UFO…")
    font.save(ufo_path, overwrite=True)
    _p(1.0, "UFO selesai")
    return report, kern_info


# ---------------------------------------------------------------------------
# 4. fontmake: UFO -> OTF + TTF
# ---------------------------------------------------------------------------
def compile_with_fontmake(ufo_path: FsPath, out_dir: FsPath):
    from fontmake.font_project import FontProject

    tmp = out_dir / "_fontmake"
    tmp.mkdir(parents=True, exist_ok=True)
    fp = FontProject()
    fp.run_from_ufos([str(ufo_path)], output=("otf", "ttf"), output_dir=str(tmp))

    otf = next(iter(sorted(tmp.rglob("*.otf"))), None)
    ttf = next(iter(sorted(tmp.rglob("*.ttf"))), None)
    if not otf or not ttf:
        raise RuntimeError(f"fontmake tidak menghasilkan OTF/TTF di {tmp}")

    final_otf = out_dir / (otf.stem + ".otf")
    final_ttf = out_dir / (ttf.stem + ".ttf")
    final_otf.write_bytes(otf.read_bytes())
    final_ttf.write_bytes(ttf.read_bytes())
    return final_otf, final_ttf


# ---------------------------------------------------------------------------
# 5. fontTools: OTF -> WOFF + WOFF2
# ---------------------------------------------------------------------------
def wrap_web(src: FsPath, out_dir: FsPath):
    outputs = {}
    for flavor, ext in (("woff", "woff"), ("woff2", "woff2")):
        f = TTFont(str(src))
        f.flavor = flavor
        dst = out_dir / (src.stem + "." + ext)
        f.save(str(dst))
        outputs[flavor] = dst
    return outputs


# ---------------------------------------------------------------------------
# 6. Preview HTML (uji visual di browser tanpa install)
# ---------------------------------------------------------------------------
def write_preview(out_dir: FsPath, woff2: FsPath, family: str, report, demo: str):
    chars = "".join(chr(r["unicode"]) for r in report if r["unicode"])
    html = f"""<!doctype html><meta charset=utf-8>
<title>Sensatype Smoke Test — {family}</title>
<style>
  @font-face {{ font-family:"SmokeTest"; src:url("{woff2.name}") format("woff2"); }}
  body {{ font-family:system-ui,sans-serif; margin:40px; background:#111; color:#eee; }}
  .sample {{ font-family:"SmokeTest"; color:#fff; }}
  .big {{ font-size:140px; line-height:1.1; }}
  .mid {{ font-size:64px; }}
  .check {{ font-size:90px; background:#fff; color:#000; padding:10px 20px; display:inline-block; }}
  code {{ color:#9cf; }}
</style>
<h2>{family} — smoke test preview</h2>
<p>Uji winding: counter pada <code>o/e/O</code> harus <b>berlubang</b> (lihat warna latar tembus, bukan hitam solid).</p>
<div class="check sample">{chars}</div>
<div class="big sample">{chars}</div>
<div class="mid sample">{demo}</div>
<hr>
<p style="font-family:monospace;font-size:13px;color:#aaa">Glyphs: {", ".join(r["glyph"] for r in report)}</p>
"""
    p = out_dir / "preview.html"
    p.write_text(html, encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description="Sensatype Fase 1 smoke test: SVG -> OTF/TTF/WOFF/WOFF2")
    ap.add_argument("--input", "-i", default="svg", help="folder berisi file .svg (default: svg)")
    ap.add_argument("--out", "-o", default="build", help="folder output (default: build)")
    ap.add_argument("--upm", type=int, default=1000, help="units per em (default 1000)")
    ap.add_argument("--baseline-ratio", type=float, default=0.80,
                    help="posisi baseline dari atas viewBox, 0-1 (default 0.80)")
    ap.add_argument("--family", default="Sensatype Smoke", help="family name")
    ap.add_argument("--style", default="Regular", help="style name")
    ap.add_argument("--demo", default="Hone the engine", help="teks demo di preview")
    # --- auto-spacing (HT Letterspacer) ---
    ap.add_argument("--autospace", action="store_true", help="seed spacing otomatis (HT Letterspacer)")
    ap.add_argument("--htls-area", type=float, default=400.0, help="HTLS paramArea / 'color' (default 400)")
    ap.add_argument("--htls-depth", type=float, default=15.0, help="HTLS paramDepth %% xHeight (default 15)")
    ap.add_argument("--htls-over", type=float, default=0.0, help="HTLS overshoot %% xHeight (default 0)")
    ap.add_argument("--reference", default=None, help="nama glyph referensi zona (mis. n / H / x); default: tiap glyph sendiri")
    ap.add_argument("--xheight", type=float, default=None, help="override xHeight (unit em) untuk HTLS")
    ap.add_argument("--preset", default=None,
                    help="nama preset (engine/presets.json): display-serif/text-serif/text-sans/display-sans")
    # --- seed kerning Tier-1 (class-level) ---
    ap.add_argument("--kern", action="store_true", help="seed kerning Tier-1 class-level (groups.plist)")
    ap.add_argument("--kern-reference", default="n", help="glyph pasangan referensi flat utk target kern (default n)")
    ap.add_argument("--kern-target", type=float, default=None, help="override target celah kern (unit em)")
    ap.add_argument("--kern-deadband", type=float, default=8, help="abaikan kern di bawah nilai ini (default 8)")
    args = ap.parse_args(argv)

    in_dir = FsPath(args.input)
    out_dir = FsPath(args.out)
    if not in_dir.is_dir():
        print(f"✗ Folder input tidak ada: {in_dir.resolve()}", file=sys.stderr)
        return 2
    svg_files = sorted(in_dir.glob("*.svg"))
    if not svg_files:
        print(f"✗ Tidak ada file .svg di {in_dir.resolve()}", file=sys.stderr)
        print("  Taruh SVG (mis. H.svg O.svg n.svg e.svg) lalu jalankan lagi.", file=sys.stderr)
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"▶ Input : {in_dir.resolve()}  ({len(svg_files)} SVG)")
    print(f"▶ Output: {out_dir.resolve()}")
    print(f"▶ UPM={args.upm}  baseline-ratio={args.baseline_ratio}  family='{args.family}' style='{args.style}'\n")

    # 1-3: SVG -> UFO
    ufo_path = out_dir / (args.family.replace(" ", "") + "-" + args.style.replace(" ", "") + ".ufo")
    report, kern_info = build_ufo(svg_files, ufo_path, upm=args.upm, baseline_ratio=args.baseline_ratio,
                       family=args.family, style=args.style,
                       autospace=args.autospace, htls_area=args.htls_area,
                       htls_depth=args.htls_depth, htls_over=args.htls_over,
                       reference=args.reference, xheight=args.xheight, preset=args.preset,
                       kern=args.kern, kern_reference=args.kern_reference,
                       kern_target=args.kern_target, kern_deadband=args.kern_deadband)

    print("── Glyph (setelah bersihkan geometri) ──")
    print(f"  {'file':<18}{'glyph':<10}{'U+':<8}{'adv':>6}{'kontur':>8}  bounds")
    for r in report:
        u = (f"{r['unicode']:04X}" + ("*" if r["pua"] else "")) if r["unicode"] is not None else "—"
        b = r["bounds"]
        bs = f"({b.xMin:.0f},{b.yMin:.0f})-({b.xMax:.0f},{b.yMax:.0f})" if b else "kosong"
        print(f"  {r['file']:<18}{r['glyph']:<10}{u:<8}{r['advance']:>6}{r['contours']:>8}  {bs}")
    print("  (* = codepoint PUA auto-assign untuk glyph custom)\n")

    # Laporan auto-spacing (verifikasi seed masuk akal — fokus Fase 2)
    if args.autospace:
        if args.preset:
            import presets as _p
            pn, pd = _p.get_preset(args.preset)
            h = pd.get("htls", {})
            ea, ed = h.get("area", args.htls_area), h.get("depth", args.htls_depth)
            refs = ", ".join(f"{k}→{v.get('reference')}" for k, v in pd.get("categories", {}).items())
            print(f"── Auto-spacing seed (preset '{pn}' · area={ea:g} depth={ed:g} · ref per-kategori: {refs}) ──")
        else:
            ref = args.reference or "(tiap glyph sendiri)"
            print(f"── Auto-spacing seed (HT Letterspacer · area={args.htls_area:g} depth={args.htls_depth:g} ref={ref}) ──")
        print(f"  {'glyph':<10}{'LSB':>6}{'RSB':>6}  →{'LSB':>6}{'RSB':>6}{'adv':>7}")
        for r in report:
            if r.get("new_lsb") is None:
                print(f"  {r['glyph']:<10}{r.get('old_lsb',0):>6}{r.get('old_rsb',0):>6}   (dilewati: di luar zona)")
                continue
            print(f"  {r['glyph']:<10}{r['old_lsb']:>6}{r['old_rsb']:>6}  →{r['new_lsb']:>6}{r['new_rsb']:>6}{r['advance']:>7}")
        print()

    # Laporan seed kerning Tier-1 (class-level)
    if kern_info:
        print(f"── Seed kerning Tier-1 (class-level · target celah={kern_info['target']} em) ──")
        print("  Grup kiri (public.kern1, per profil sisi KANAN):")
        for g, members in kern_info["kern1_groups"].items():
            print(f"    {g:<22} = {', '.join(members)}")
        print("  Grup kanan (public.kern2, per profil sisi KIRI):")
        for g, members in kern_info["kern2_groups"].items():
            print(f"    {g:<22} = {', '.join(members)}")
        if kern_info["pairs"]:
            print("  Pasangan kelas (nilai em):")
            for (a, b), v in sorted(kern_info["pairs"].items(), key=lambda kv: kv[1]):
                ea = a.split(".")[-1]; eb = b.split(".")[-1]
                print(f"    {ea:>4} | {eb:<4} ({a} , {b}) = {v:+d}")
        else:
            print("  (tidak ada pasangan melewati deadband)")
        print()

    # 4: fontmake -> OTF/TTF
    print("── Kompilasi (fontmake) ──")
    otf, ttf = compile_with_fontmake(ufo_path, out_dir)
    print(f"  ✓ {otf.name}")
    print(f"  ✓ {ttf.name}")

    # 5: WOFF/WOFF2
    print("── Web (fontTools) ──")
    web = wrap_web(otf, out_dir)
    for fl, p in web.items():
        print(f"  ✓ {p.name}")

    # 6: verifikasi keempat file terbuka & preview
    print("\n── Verifikasi (parse ulang ke-4 format) ──")
    ok = True
    for f in (otf, ttf, web["woff"], web["woff2"]):
        try:
            tt = TTFont(str(f))
            n = len(tt.getGlyphOrder())
            sz = f.stat().st_size
            print(f"  ✓ {f.name:<32} {n} glyph, {sz:,} bytes")
        except Exception as e:
            ok = False
            print(f"  ✗ {f.name}: {e}")

    preview = write_preview(out_dir, web["woff2"], args.family, report, args.demo)
    print(f"\n  ▸ Preview browser: {preview.resolve()}")
    print(f"  ▸ UFO project    : {ufo_path.resolve()}")

    # Cek korektness ringkas: glyph dengan counter harus >1 kontur.
    print("\n── Cek korektness winding (otomatis) ──")
    for r in report:
        ch = chr(r["unicode"]) if r["unicode"] else ""
        if ch in "oOeaAbBdDpPqQgR069@":  # glyph yang lazim punya counter
            status = "✓ counter terdeteksi" if r["contours"] >= 2 else "⚠ HANYA 1 kontur — cek winding!"
            print(f"  {r['glyph']:<8} {r['contours']} kontur  {status}")

    print("\n✅ Selesai." if ok else "\n⚠ Selesai dengan peringatan.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
