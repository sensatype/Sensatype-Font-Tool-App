"""
Specimen splitter — pecah satu SVG specimen (grid karakter) jadi SVG per-glyph.

Cikal-bakal fitur batch-import (PRD §7: "drag-drop SVG → assign ke glyph ... batch").
Untuk Yoruna Full: tiap huruf baris kapital/minuscule = 1 path → urut posisi-x → A–Z / a–z.

Output: file `uniXXXX.svg` (case-safe di filesystem case-insensitive macOS), sudah
dinormalisasi ke konvensi kanvas-tetap engine (tinggi viewBox = 1 em, baseline di
`--baseline-ratio` dari atas). Lalu jalankan `smoke_test.py` pada folder hasil.

Asumsi v1: huruf alfabet = 1 path per glyph (counter/titik = compound). Baris simbol/
tanda baca BELUM didukung (urutan ambigu) — tahap berikut.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import string
from collections import defaultdict
from pathlib import Path as FsPath

from picosvg.svg import SVG
from fontTools.svgLib.path import parse_path
from fontTools.pens.boundsPen import ControlBoundsPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.svgPathPen import SVGPathPen

ROW_CHARSETS = {
    "upper": string.ascii_uppercase,
    "lower": string.ascii_lowercase,
    "digits": "0123456789",
}

_LAYOUT_DIR = FsPath(__file__).with_name("layouts")


def _cell(v):
    """Cell layout = codepoint (int, atau str '0x41'/'0041') ATAU nama glyph ('A.ss01', 'f_i', 'Aacute').

    Codepoint: int, atau string berawalan '0x', atau string hex murni 4-6 digit.
    Nama glyph: string lain (mengandung '.', '_', huruf di luar a-f, dst.)."""
    if isinstance(v, int):
        return v
    s = v.strip()
    if s.lower().startswith("0x"):
        return int(s, 16)
    if re.fullmatch(r"[0-9A-Fa-f]{4,6}", s):  # 'uniXXXX'-style hex murni
        return int(s, 16)
    return s  # nama glyph


def load_layout(name_or_path):
    """Layout = daftar baris; tiap baris = daftar cell (codepoint atau nama glyph), urut posisi-x."""
    p = FsPath(name_or_path)
    if not p.exists():
        p = _LAYOUT_DIR / (name_or_path + ".json")
    data = json.loads(p.read_text(encoding="utf-8"))
    rows = [[_cell(c) for c in row] for row in data["rows"]]
    kinds = data.get("row_kinds") or ["glyph"] * len(rows)
    return rows, kinds


def _load_paths(svg_file):
    raw = FsPath(svg_file).read_text(encoding="utf-8")
    raw = re.sub(r"(?<=[\d.])(px|pt)\b", "", raw)
    svg = SVG.fromstring(raw).topicosvg(drop_unsupported=True)
    vb = svg.view_box()
    items = []
    for s in svg.shapes():
        d = getattr(s, "d", None)
        if not d:
            continue
        p = ControlBoundsPen(None)
        try:
            parse_path(d, p)
        except Exception:
            continue
        if p.bounds:
            items.append((p.bounds, d))  # bounds Y-down (x0,y0,x1,y1)
    return items, vb


def _detect_rows(items, vb, row_gap_frac=0.045, n_rows=None):
    H = vb[3]
    ycenters = sorted(set((b[1] + b[3]) / 2 for b, _ in items))
    if n_rows and n_rows < len(ycenters):
        # known-count: pecah jadi tepat n_rows band via (n_rows-1) gap-y terbesar
        gaps = sorted(
            ((ycenters[i + 1] - ycenters[i], i) for i in range(len(ycenters) - 1)),
            reverse=True)[: n_rows - 1]
        cuts = sorted(i for _, i in gaps)
        groups, start = [], 0
        for c in cuts:
            groups.append(ycenters[start:c + 1])
            start = c + 1
        groups.append(ycenters[start:])
        centers = [sum(g) / len(g) for g in groups]
        rows = defaultdict(list)
        for b, d in items:
            yc = (b[1] + b[3]) / 2
            ri = min(range(len(centers)), key=lambda i: abs(centers[i] - yc))
            rows[ri].append((b, d))
        return rows, centers

    # AUTO: deteksi baris via STRIP-Y TERISI (interval ink yang overlap = satu baris).
    # Robust thd variasi tinggi glyph dalam satu baris (diakritik tinggi, descender rendah)
    # — tidak memecah baris fisik seperti clustering y-center.
    intervals = sorted((b[1], b[3]) for b, _ in items)  # (yMin, yMax), Y-down
    bands = [list(intervals[0])]
    for y0, y1 in intervals[1:]:
        if y0 <= bands[-1][1] + H * 0.006:  # overlap / nyaris menempel → baris sama
            bands[-1][1] = max(bands[-1][1], y1)
        else:
            bands.append([y0, y1])
    rows = defaultdict(list)
    for b, d in items:
        yc = (b[1] + b[3]) / 2
        ri = next((i for i, (lo, hi) in enumerate(bands) if lo <= yc <= hi),
                  min(range(len(bands)), key=lambda i: abs((bands[i][0] + bands[i][1]) / 2 - yc)))
        rows[ri].append((b, d))
    return rows, [(lo + hi) / 2 for lo, hi in bands]


def _gap_groups(row, gap):
    """Kelompokkan path (urut x0) jadi glyph via celah-x > gap (auto, tanpa known-count)."""
    row = sorted(row, key=lambda t: t[0][0])
    groups = [[row[0]]]
    mx = row[0][0][2]
    for b, d in row[1:]:
        if b[0] - mx > gap:
            groups.append([])
        groups[-1].append((b, d))
        mx = max(mx, b[2])
    return groups


def extract_shapes(svg_file, *, cap_target=700):
    """Ekstrak SEMUA glyph dalam koordinat MENTAH (asli SVG, Y-down) + garis panduan
    baseline/cap per baris (default auto, bisa diubah user). Tidak menormalisasi vertikal —
    normalisasi dilakukan saat commit memakai posisi garis. Reading order via band+x.

    Return: {shapes:[{paths:[d_mentah], bbox, band}], guides:[{y,type}], viewBox:[x,y,w,h]}.
    """
    items, vb = _load_paths(svg_file)
    if not items:
        return {"shapes": [], "guides": [], "viewBox": [0, 0, 1, 1]}
    rows, _centers = _detect_rows(items, vb)
    shapes, guides = [], []
    for band, ri in enumerate(sorted(rows)):
        row = rows[ri]
        base_row = _row_baseline(row)  # baseline mentah (median yMax glyph tinggi)
        maxh = max(b[3] - b[1] for b, _ in row)
        tall_tops = [b[1] for b, _ in row if (b[3] - b[1]) >= 0.55 * maxh]
        cap_y = min(tall_tops) if tall_tops else min(b[1] for b, _ in row)
        guides.append({"y": round(base_row, 1), "type": "baseline"})
        guides.append({"y": round(cap_y, 1), "type": "cap"})
        for b, d in row:
            shapes.append({"paths": [d], "band": band,
                           "bbox": [round(b[0], 1), round(b[1], 1), round(b[2], 1), round(b[3], 1)]})
    shapes.sort(key=lambda s: (s["band"], (s["bbox"][0] + s["bbox"][2]) / 2))
    return {"shapes": shapes, "guides": guides, "viewBox": list(vb)}


def _cluster(row, n):
    """Kelompokkan path (urut x0) jadi `n` glyph via (n-1) gap terbesar.
    Menangani glyph MULTI-PATH (mis. ligatur Black: 25 path -> 14 glyph)."""
    if len(row) <= n:
        return [[it] for it in row]
    mx = row[0][0][2]
    gaps = []
    for i in range(1, len(row)):
        gaps.append((row[i][0][0] - mx, i))
        mx = max(mx, row[i][0][2])
    split_idx = {i for _, i in sorted(gaps, reverse=True)[: n - 1]}
    groups, cur = [], [row[0]]
    for i in range(1, len(row)):
        if i in split_idx:
            groups.append(cur)
            cur = []
        cur.append(row[i])
    groups.append(cur)
    return groups


def _row_baseline(group):
    """Baseline baris = median yMax glyph TINGGI (huruf/kurung/$/€ bertumpu baseline),
    abaikan simbol kecil yang melayang (bullet, derajat, kutip, dash) agar penempatan benar."""
    heights = [b[3] - b[1] for b, _ in group]
    maxh = max(heights) if heights else 0
    tall = [b[3] for b, _ in group if (b[3] - b[1]) >= 0.55 * maxh]
    return statistics.median(tall) if tall else statistics.median(b[3] for b, _ in group)


def _emit_row(row_items, cells, *, scale, base_row, baseY, upm, margin, out, seen, names):
    """Emit satu baris: urut path per-x, kelompokkan jadi len(cells) glyph, petakan ke cells."""
    row = sorted(row_items, key=lambda t: t[0][0])  # urut left-edge
    groups = _cluster(row, len(cells))
    n = min(len(groups), len(cells))
    warn = None
    if len(row) != len(cells) and len(groups) != len(cells):
        warn = f"{len(row)} path -> {len(groups)} glyph vs {len(cells)} cell — petakan {n} pertama"
    fy = baseY - base_row * scale
    emitted = []
    for i in range(n):
        group = groups[i]
        cell = cells[i]
        if cell in seen:
            print(f"  ⚠ cell dobel {cell!r} dilewati (sudah dipakai)")
            continue
        seen.add(cell)
        gx0 = min(b[0] for b, _ in group)
        gx1 = max(b[2] for b, _ in group)
        ex = margin - gx0 * scale
        paths = []
        for (b, d) in group:
            spen = SVGPathPen(None)
            parse_path(d, TransformPen(spen, (scale, 0, 0, scale, ex, fy)))
            paths.append(f'<path fill-rule="evenodd" d="{spen.getCommands()}"/>')
        W = round((gx1 - gx0) * scale + 2 * margin)
        if isinstance(cell, int):
            fn = out / f"uni{cell:04X}.svg"
            label = chr(cell)
        else:
            stem = f"g{len(names):04d}"  # file netral + sidecar (aman kasus macOS)
            fn = out / f"{stem}.svg"
            names[stem] = cell
            label = cell
        fn.write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {upm}">'
            + "".join(paths) + "</svg>",
            encoding="utf-8")
        emitted.append((label, fn.name))
    return emitted, warn


def split(svg_file, out_dir, *, rows_spec=("upper", "lower"), layout=None, upm=1000,
          baseline_ratio=0.8, cap_target=700, margin=60):
    items, vb = _load_paths(svg_file)
    n_rows = len(layout[0]) if layout else None
    rows, centers = _detect_rows(items, vb, n_rows=n_rows)
    out = FsPath(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    baseY = upm * baseline_ratio

    # skala global dari cap height baris kapital (row 0 = baris paling atas)
    up = sorted(rows[0], key=lambda t: (t[0][0] + t[0][2]) / 2)
    base0 = statistics.median(b[3] for b, _ in up)
    captop = min(b[1] for b, _ in up)
    scale = cap_target / (base0 - captop)

    # tentukan codepoint per baris fisik
    if layout is not None:
        layout_rows, _kinds = layout
        if len(layout_rows) != len(centers):
            print(f"  ⚠ layout {len(layout_rows)} baris, terdeteksi {len(centers)} baris di SVG.")
        row_cps = {ri: layout_rows[ri] for ri in range(min(len(layout_rows), len(centers)))}
    else:
        row_cps = {}
        for ri, label in enumerate(rows_spec):
            chars = ROW_CHARSETS.get(label)
            if chars and ri in rows:
                row_cps[ri] = [ord(c) for c in chars]

    emitted = []
    seen = set()
    names: dict[str, str] = {}
    for ri in sorted(row_cps):
        if ri not in rows:
            continue
        base_row = _row_baseline(rows[ri])
        em, warn = _emit_row(rows[ri], row_cps[ri], scale=scale, base_row=base_row,
                             baseY=baseY, upm=upm, margin=margin, out=out, seen=seen, names=names)
        if warn:
            print(f"  ⚠ baris {ri}: {warn}")
        emitted += em
    if names:
        (out / "_names.json").write_text(json.dumps(names, indent=1), encoding="utf-8")
    return emitted


def main(argv=None):
    ap = argparse.ArgumentParser(description="Pecah SVG specimen -> per-glyph (uniXXXX.svg)")
    ap.add_argument("--input", "-i", required=True, help="file SVG specimen")
    ap.add_argument("--out", "-o", required=True, help="folder output per-glyph")
    ap.add_argument("--rows", default="upper,lower",
                    help="label baris urut dari atas (upper,lower,digits) — diabaikan bila --layout dipakai")
    ap.add_argument("--layout", default=None,
                    help="nama/path layout JSON (mis. yoruna-full) — codepoint eksplisit per baris")
    ap.add_argument("--upm", type=int, default=1000)
    ap.add_argument("--baseline-ratio", type=float, default=0.8)
    ap.add_argument("--cap-target", type=float, default=700, help="cap height target (unit em)")
    args = ap.parse_args(argv)
    layout = load_layout(args.layout) if args.layout else None
    rows_spec = tuple(r.strip() for r in args.rows.split(","))
    emitted = split(args.input, args.out, rows_spec=rows_spec, layout=layout, upm=args.upm,
                    baseline_ratio=args.baseline_ratio, cap_target=args.cap_target)
    print(f"✓ {len(emitted)} glyph -> {FsPath(args.out).resolve()}")
    print("  " + " ".join(ch for ch, _ in emitted))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
