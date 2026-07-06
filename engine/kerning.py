"""
Seed kerning Tier-1 (class-level, distance/area-based) untuk UFO.

Sesuai PRD §5/§8 & CONTEXT D8/D9/§9.6/§9.7:
  - LEVEL KELAS: tulis ke groups.plist (public.kern1/public.kern2) + kerning.plist,
    BUKAN raw pair (raw pair = jurang n² yang bikin mangkrak).
  - Tier-1 saja: seed otomatis "cukup baik", finishing manual. BUKAN Tier-2/optical/iKern.

Metode (distance-based yang benar = RATA-RATA celah, bukan jarak titik terdekat):
  Untuk pasangan (L,R), pada tiap ketinggian y di irisan rentang ink:
      gap(y) = (advanceL - rightEdgeL(y)) + leftEdgeR(y)
  avgGap = rata-rata gap(y).  kern = round(target - avgGap).
  target = avgGap dari pasangan referensi flat (default 'n'|'n').
  -> pasangan bulat (O|O) punya avgGap besar (celah lensa) -> kern negatif (rapatkan);
     pasangan lurus (n|n) ~ target -> kern ~0.  Arah benar.

Grouping: glyph dikelompokkan per BENTUK sisi:
  - public.kern1.* (posisi KIRI/pertama)  dikelompokkan per profil sisi KANAN,
  - public.kern2.* (posisi KANAN/kedua)  dikelompokkan per profil sisi KIRI.
Satu nilai kern disimpan per pasangan kelas (eksemplar), dipakai bersama semua anggota.

Tidak ada dependensi baru: pakai mesin scanline di htls.py (fontTools saja).
"""
from __future__ import annotations

import htls  # _flatten, _margins_at, _bounds


def _profiles(glyph):
    c = htls._flatten(glyph)
    if not c:
        return None
    return c, htls._bounds(c)


def _avg_gap(Lc, Ladv, Rc, step):
    """Rata-rata celah berhadapan antara sisi kanan L dan sisi kiri R."""
    Lb = htls._bounds(Lc)
    Rb = htls._bounds(Rc)
    y0 = max(Lb[1], Rb[1])
    y1 = min(Lb[3], Rb[3])
    if y1 <= y0:
        return None
    gaps = []
    y = y0
    while y <= y1:
        l = htls._margins_at(Lc, y)   # (minx, maxx) sisi ink L
        r = htls._margins_at(Rc, y)
        if l[1] is not None and r[0] is not None:
            gaps.append((Ladv - l[1]) + r[0])
        y += step
    if not gaps:
        return None
    return sum(gaps) / len(gaps)


def _side_signature(contours, b, side, samples, upm):
    """Tanda-tangan BENTUK satu sisi (kedalaman ink dari ekstrem), terlepas dari sidebearing."""
    minY, maxY = b[1], b[3]
    if maxY <= minY:
        return ("flat",)
    # ekstrem sisi
    edges = []
    for i in range(samples):
        y = minY + (maxY - minY) * (i + 0.5) / samples
        mn, mx = htls._margins_at(contours, y)
        edges.append((mn, mx))
    if side == "right":
        vals = [mx for mn, mx in edges if mx is not None]
        if not vals:
            return ("none",)
        extreme = max(vals)
        depth = [round((extreme - (mx if mx is not None else extreme)) / (upm * 0.04)) for mn, mx in edges]
    else:  # left
        vals = [mn for mn, mx in edges if mn is not None]
        if not vals:
            return ("none",)
        extreme = min(vals)
        depth = [round(((mn if mn is not None else extreme) - extreme) / (upm * 0.04)) for mn, mx in edges]
    return tuple(depth)


def _reference_target(font, upm, step, refs=("n", "H", "o", "x", "m", "u")):
    """Celah 'datar' acuan = avgGap pasangan referensi lurus (mis. n|n). Basis kalibrasi
    smart kern: pasangan yang lebih 'terbuka' dari acuan → kern negatif (rapatkan)."""
    for ref in refs:
        if ref in font:
            p = _profiles(font[ref])
            if p:
                t = _avg_gap(p[0], font[ref].width, p[0], step)
                if t is not None:
                    return t
    return upm * 0.16


def smart_pair(font, left, right, *, upm, step=10, deadband=3, clamp_frac=0.18, target=None):
    """Kern optikal (sadar-bentuk) untuk SATU pasangan. TIDAK menulis apa pun — hanya menghitung.
    Bentuk lurus/bulat/menjorok/diagonal menyesuaikan sendiri lewat avgGap berhadapan.
    Return int (0 bila tak ada data atau dalam deadband)."""
    if left not in font or right not in font:
        return 0
    Lp = _profiles(font[left])
    Rp = _profiles(font[right])
    if not Lp or not Rp:
        return 0
    if target is None:
        target = _reference_target(font, upm, step)
    avg = _avg_gap(Lp[0], font[left].width, Rp[0], step)
    if avg is None:
        return 0
    k = round(target - avg)
    if abs(k) < deadband:
        return 0
    clamp = upm * clamp_frac
    return int(max(-clamp, min(clamp, k)))


def auto_kern_pairs(font, names, *, upm, step=10, deadband=6, clamp_frac=0.18, target=None):
    """Kern optikal untuk SEMUA pasangan berurutan dari `names`. Return {(L,R): int} hanya utk
    |v|>=deadband. TIDAK menulis. Tabel margin per glyph DIPRAKOMPUTASI pada grid-y bersama
    (kelipatan `step`) → tiap pasangan tinggal lookup, bukan scan segmen O(n²) (yang membuat
    font berkontur rumit makan waktu bermenit-menit & menahan lock tulis)."""
    import math
    data = {}
    for n in names:
        if n in font:
            p = _profiles(font[n])
            if p:
                data[n] = p
    ns = [n for n in names if n in data]
    if target is None:
        target = _reference_target(font, upm, step)
    clamp = upm * clamp_frac
    # tabel margin per glyph: y (grid bersama) -> (minX, maxX)
    tables = {}
    for n in ns:
        c, b = data[n]
        tab = {}
        y = math.ceil(b[1] / step) * step
        while y <= b[3]:
            mn, mx = htls._margins_at(c, y)
            if mn is not None:
                tab[y] = (mn, mx)
            y += step
        tables[n] = (tab, b)
    out = {}
    for L in ns:
        Ltab, Lb = tables[L]
        Ladv = font[L].width
        for R in ns:
            Rtab, Rb = tables[R]
            y0 = max(Lb[1], Rb[1])
            y1 = min(Lb[3], Rb[3])
            if y1 <= y0:
                continue
            gaps = []
            y = math.ceil(y0 / step) * step
            while y <= y1:
                l = Ltab.get(y)
                r = Rtab.get(y)
                if l and r:
                    gaps.append((Ladv - l[1]) + r[0])
                y += step
            if not gaps:
                continue
            k = round(target - sum(gaps) / len(gaps))
            if abs(k) < deadband:
                continue
            out[(L, R)] = int(max(-clamp, min(clamp, k)))
    return out


def build_kerning(font, glyph_names, *, upm, reference="n", target=None,
                  deadband=8, step=10, samples=10, clamp_frac=0.15):
    """Hitung & tulis seed kerning class-level ke `font`. Return dict laporan."""
    data = {}
    for n in glyph_names:
        p = _profiles(font[n])
        if p:
            data[n] = p  # (contours, bounds)
    names = [n for n in glyph_names if n in data]

    # --- grouping per bentuk sisi ---
    kern1 = {}  # sig_right -> [glyphs]  (posisi kiri)
    kern2 = {}  # sig_left  -> [glyphs]  (posisi kanan)
    for n in names:
        c, b = data[n]
        sr = _side_signature(c, b, "right", samples, upm)
        sl = _side_signature(c, b, "left", samples, upm)
        kern1.setdefault(sr, []).append(n)
        kern2.setdefault(sl, []).append(n)

    # nama grup (pakai eksemplar = anggota pertama)
    kern1_groups = {f"public.kern1.{members[0]}": members for members in kern1.values()}
    kern2_groups = {f"public.kern2.{members[0]}": members for members in kern2.values()}
    g1_of = {g: gname for gname, gs in kern1_groups.items() for g in gs}
    g2_of = {g: gname for gname, gs in kern2_groups.items() for g in gs}

    # --- target dari pasangan referensi flat ---
    if target is None:
        if reference in data:
            rc, rb = data[reference]
            target = _avg_gap(rc, font[reference].width, rc, step)
        if target is None:
            # fallback: median avgGap pasangan eksemplar lurus -> pakai 2*sidebearing rata2
            target = upm * 0.16

    clamp = upm * clamp_frac
    # --- kern per pasangan kelas (eksemplar) ---
    pairs = {}
    for g1name, m1 in kern1_groups.items():
        Lname = m1[0]
        Lc, _ = data[Lname]
        Ladv = font[Lname].width
        for g2name, m2 in kern2_groups.items():
            Rname = m2[0]
            Rc, _ = data[Rname]
            avg = _avg_gap(Lc, Ladv, Rc, step)
            if avg is None:
                continue
            k = round(target - avg)
            if abs(k) < deadband:
                continue
            k = max(-clamp, min(clamp, k))
            pairs[(g1name, g2name)] = int(k)

    # --- tulis ke UFO ---
    for gname, members in {**kern1_groups, **kern2_groups}.items():
        font.groups[gname] = members
    for key, val in pairs.items():
        font.kerning[key] = val

    return {
        "target": round(target),
        "kern1_groups": kern1_groups,
        "kern2_groups": kern2_groups,
        "pairs": pairs,
        "g1_of": g1_of,
        "g2_of": g2_of,
    }
