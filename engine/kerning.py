"""
Kerning optikal SADAR-BENTUK (class-level) untuk UFO — mesin "Smart Kerning".

Sesuai PRD §5/§8 & CONTEXT D8/D9/§9.6/§9.7:
  - LEVEL KELAS: tulis ke groups.plist (public.kern1/public.kern2) + kerning.plist,
    BUKAN raw pair (raw pair = jurang n² yang bikin mangkrak).

Model optik v3 — "kenali kerangka tiap glyph, hasil seimbang" (tak terlalu rapat/renggang):

  1. SCANLINE. Untuk pasangan (L,R), pada tiap ketinggian y di irisan rentang ink diukur
     margin kanan L (tinta terkanan) & margin kiri R (tinta terkiri).

  2. CONE-FILL 45° (kunci kecerdasan). Margin diisi memakai kerucut 45° dari titik ekstrem:
       - COUNTER TERTUTUP (mulut 'c', apertur 'e/G/S') → TERISI: kantong dalam ditutup dinding
         atas+bawahnya → tak dihitung sbg celah → huruf berikut TAK ditusuk masuk ke mulut.
       - FLANK TERBUKA ('T' di bawah palang, 'L' di atas kaki, 'V/A/Y' diagonal) → DIPERTAHANKAN:
         terbuka sampai batas zona, tak ada dinding utk menutup → tetap dihitung → dirapatkan.
     Inilah beda "terlalu dekat/jauh" vs "seimbang": model lama tak bisa membedakan mulut-counter
     (jangan dirapatkan) dari flank-terbuka (rapatkan), sehingga c|o over-tusuk & T|a acak.

  3. OPENNESS. Rata-rata terbobot-tengah dari celah TERISI (pusat zona berbobot penuh, tepi
     meluruh) = seberapa "terbuka" pasangan secara perseptual.
       kern = target − openness.
     target = openness pasangan referensi LURUS (median I|I, H|H, l|l, N|N, …) — DIUKUR DENGAN
     JALUR YANG SAMA → pasangan lurus (H|H) otomatis ~0 (tak "diperbaiki" sia-sia), dan skala
     mengikuti spacing font itu sendiri (gelap/terang, rapat/lega).

  4. LANTAI ANTI-TABRAKAN. Kern negatif tak boleh membuat celah NYATA (bukan terisi) minimum
     turun di bawah safe_frac×target → runcing/serif tak bersentuhan, dan tak pernah dipaksa
     merenggang. Deadband membuang koreksi <~0.8% em (noise), clamp membatasi ekstrem.

Grouping (impor/seed): glyph dikelompokkan per BENTUK sisi (public.kern1/2.*), satu nilai kern
per pasangan kelas (eksemplar) dipakai bersama anggotanya.

Tidak ada dependensi baru: pakai mesin scanline di htls.py (fontTools saja).
"""
from __future__ import annotations

import math
import statistics

import htls  # _flatten, _margins_at, _bounds


def _profiles(glyph):
    c = htls._flatten(glyph)
    if not c:
        return None
    return c, htls._bounds(c)


# ── cone-fill 45° (tutup counter, pertahankan flank terbuka) ────────────────────
# Dua-lintas (grassfire) O(n): tiap titik tak boleh "jatuh" dari tetangganya lebih curam dari
# `slope` → lembah sempit (counter berdinding) terisi; ramp yg mencapai batas zona (flank) tetap.
def _cone_close_right(ys, xs, slope):
    """Margin KANAN L: naikkan x ke arah ekstrem (max) dgn kemiringan ≤ slope."""
    n = len(xs)
    out = list(xs)
    for i in range(1, n):
        d = (ys[i] - ys[i - 1]) * slope
        if out[i] < out[i - 1] - d:
            out[i] = out[i - 1] - d
    for i in range(n - 2, -1, -1):
        d = (ys[i + 1] - ys[i]) * slope
        if out[i] < out[i + 1] - d:
            out[i] = out[i + 1] - d
    return out


def _cone_close_left(ys, xs, slope):
    """Margin KIRI R: turunkan x ke arah ekstrem (min) dgn kemiringan ≤ slope."""
    n = len(xs)
    out = list(xs)
    for i in range(1, n):
        d = (ys[i] - ys[i - 1]) * slope
        if out[i] > out[i - 1] + d:
            out[i] = out[i - 1] + d
    for i in range(n - 2, -1, -1):
        d = (ys[i + 1] - ys[i]) * slope
        if out[i] > out[i + 1] + d:
            out[i] = out[i + 1] + d
    return out


def _glyph_margins(contours, bounds, step, slope):
    """Tabel margin satu glyph pada grid-y (kelipatan step): y → (rawR, filledR, rawL, filledL).
    Cone-fill dihitung atas SELURUH tinggi glyph (ekstrem benar), lalu di-window per pasangan.
    Return (tabel, bounds)."""
    ys, R, L = [], [], []
    y = math.ceil(bounds[1] / step) * step
    while y <= bounds[3]:
        mn, mx = htls._margins_at(contours, y)
        if mn is not None:
            ys.append(y); R.append(mx); L.append(mn)
        y += step
    if len(ys) < 2:
        return {}, bounds
    Rf = _cone_close_right(ys, R, slope)
    Lf = _cone_close_left(ys, L, slope)
    tab = {ys[i]: (R[i], Rf[i], L[i], Lf[i]) for i in range(len(ys))}
    return tab, bounds


def _pair_openness(Ltab, Lb, Ladv, Rtab, Rb, step):
    """Dari tabel margin L & R: (openness_terisi_terbobot, celah_nyata_min) di zona overlap.
    (None, None) bila tak beririsan. openness = seberapa terbuka (perseptual); celah_nyata_min
    = titik jepit fisik terdekat (utk lantai anti-tabrakan)."""
    y0 = max(Lb[1], Rb[1])
    y1 = min(Lb[3], Rb[3])
    if y1 <= y0:
        return None, None
    ys, gapF, gapReal = [], [], []
    y = math.ceil(y0 / step) * step
    while y <= y1:
        l = Ltab.get(y); r = Rtab.get(y)
        if l and r:
            ys.append(y)
            gapF.append((Ladv - l[1]) + r[3])     # celah dari margin TERISI (filledR L, filledL R)
            gapReal.append((Ladv - l[0]) + r[2])  # celah NYATA (rawR L, rawL R)
        y += step
    if len(ys) < 2:
        return None, None
    yc = (ys[0] + ys[-1]) / 2.0
    yh = max((ys[-1] - ys[0]) / 2.0, 1.0)
    num = den = 0.0
    for i, yy in enumerate(ys):
        w = 1.0 / (1.0 + ((yy - yc) / yh) ** 2)   # bobot tengah (perseptual): pusat penuh, tepi luruh
        num += w * gapF[i]; den += w
    return num / den, min(gapReal)


def _kern_from_openness(openness, min_real, target, upm, deadband, clamp_frac, safe_frac,
                        strength=1.0):
    """openness → nilai kern int. target = openness pasangan lurus acuan (rhythm datar font).
    strength = faktor mode kerapatan (lihat MODES); 1.0 = sedang."""
    if openness is None:
        return 0
    k = (target - openness) * strength
    if k < 0:  # lantai: jaga celah nyata tersempit ≥ safe_frac×target; tak pernah paksa merenggang
        k = max(k, min(0.0, safe_frac * target - min_real))
    k = round(k)
    if abs(k) < deadband:
        return 0
    clamp = upm * clamp_frac
    return int(max(-clamp, min(clamp, k)))


# Glyph referensi LURUS (sisi hadap = batang tegak) utk kalibrasi target datar. Median → tahan
# thd satu glyph yg spacing-nya nyeleneh. Diurut dari yang paling "murni lurus".
_FLAT_REFS = ("I", "l", "H", "N", "M", "h", "n", "u", "m", "K", "E")


def _flat_target(font, upm, step, slope):
    """Rhythm datar font = median openness pasangan-diri glyph lurus (I|I, H|H, …), diukur
    dgn jalur SAMA spt pasangan biasa → pasangan lurus otomatis ~0. Fallback upm*0.16."""
    cand = []
    for r in _FLAT_REFS:
        if r in font and len(font[r]) > 0:
            p = _profiles(font[r])
            if not p:
                continue
            tab, b = _glyph_margins(p[0], p[1], step, slope)
            if not tab:
                continue
            op, _ = _pair_openness(tab, b, font[r].width, tab, b, step)
            if op is not None:
                cand.append(op)
    if cand:
        return statistics.median(cand)
    return upm * 0.16


def _deadband(upm):
    return max(2, round(0.008 * upm))  # ~0.8% em: buang koreksi tak kasat mata


# ── mode kerapatan (pilihan pengguna: dekat / sedang / jauh) ────────────────────
# Faktor KEKUATAN koreksi optik, bukan skala target. Bedanya penting:
#   - skala kekuatan: pasangan LURUS tetap 0 di semua mode (openness == target → k = 0), jadi
#     spacing yang sudah dirancang TIDAK dilawan; yang berubah hanya seberapa agresif pasangan
#     terbuka/bulat/diagonal dirapatkan.
#   - skala target (ditolak): membuat H|H ikut ter-kern (mis. +18 saat "jauh") — itu pekerjaan
#     tracking "Spasi semua", bukan kerning, dan dua kontrol jadi saling tabrakan.
# Lantai anti-tabrakan TIDAK ikut diskalakan (batas fisik, bukan selera) → "dekat" tetap aman.
MODES = {"tight": 1.20, "medium": 1.00, "loose": 0.80}
DEFAULT_MODE = "medium"


def resolve_mode(mode):
    """Nama mode → nama KANONIK yang benar-benar dipakai (tak dikenal / None → default).
    Dipakai backend utk meng-echo mode yang SUNGGUH diterapkan, bukan yang diminta."""
    return mode if mode in MODES else DEFAULT_MODE


def strength_of(mode):
    """Nama mode → faktor kekuatan. Nama tak dikenal / None → default (sedang)."""
    return MODES[resolve_mode(mode)]


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


def smart_pair(font, left, right, *, upm, step=10, slope=1.0, deadband=None,
               clamp_frac=0.15, safe_frac=0.20, target=None, mode=None):
    """Kern optikal SADAR-BENTUK untuk SATU pasangan (model v3: cone-fill + openness).
    mode = "tight"/"medium"/"loose" (lihat MODES); None = sedang.
    TIDAK menulis apa pun — hanya menghitung. Return int (0 bila tak ada data / dalam deadband)."""
    if left not in font or right not in font:
        return 0
    Lp = _profiles(font[left])
    Rp = _profiles(font[right])
    if not Lp or not Rp:
        return 0
    if deadband is None:
        deadband = _deadband(upm)
    if target is None:
        target = _flat_target(font, upm, step, slope)
    Ltab, Lb = _glyph_margins(Lp[0], Lp[1], step, slope)
    Rtab, Rb = _glyph_margins(Rp[0], Rp[1], step, slope)
    op, min_real = _pair_openness(Ltab, Lb, font[left].width, Rtab, Rb, step)
    return _kern_from_openness(op, min_real, target, upm, deadband, clamp_frac, safe_frac,
                               strength_of(mode))


def flat_target(font, upm, step=10, slope=1.0):
    """Rhythm datar font (publik) — dipakai backend utk menghitung saran banyak pasangan tanpa
    mengulang kalibrasi tiap panggilan."""
    return _flat_target(font, upm, step, slope)


def auto_kern_pairs(font, names, *, upm, step=10, slope=1.0, deadband=None,
                    clamp_frac=0.15, safe_frac=0.20, target=None, mode=None):
    """Kern optikal SADAR-BENTUK (model v3) untuk SEMUA pasangan berurutan dari `names`. Return
    {(L,R): int} hanya utk |v|>=deadband. TIDAK menulis. Tabel margin per glyph (mentah + cone-fill
    45°) DIPRAKOMPUTASI SEKALI di grid-y bersama → tiap pasangan tinggal lookup+bobot, bukan scan
    O(n²) (yg membuat font berkontur rumit makan waktu bermenit & menahan lock tulis)."""
    if deadband is None:
        deadband = _deadband(upm)
    tables = {}  # n -> (tab, bounds); tab: y -> (rawR, filledR, rawL, filledL)
    for n in names:
        if n in font:
            p = _profiles(font[n])
            if p:
                tab, b = _glyph_margins(p[0], p[1], step, slope)
                if tab:
                    tables[n] = (tab, b)
    ns = [n for n in names if n in tables]
    if target is None:
        target = _flat_target(font, upm, step, slope)
    # Kerapatan pilihan pengguna = SATU-SATUNYA pengatur seberapa rapat hasilnya (dulu ada dua:
    # mode + "belajar selera" tersembunyi — membingungkan & hasilnya sulit ditebak).
    strength = strength_of(mode)
    # "Dekat" harus benar-benar terasa: tanpa ini LANTAI anti-tabrakan mengikat hampir semua
    # pasangan (terukur 85% pada font berspasi rapat) sehingga menaikkan kekuatan tak menggerakkan
    # apa pun. Saat pengguna MEMINTA lebih rapat, batasnya ikut mengalah — dgn dasar MUTLAK
    # 0,08×target (≈1,2% em) supaya glyph tak pernah benar-benar bertabrakan.
    if strength > 1.0:
        clamp_frac = clamp_frac * strength
        safe_frac = max(0.08, safe_frac / strength)
    out = {}
    for L in ns:
        Ltab, Lb = tables[L]
        Ladv = font[L].width
        for R in ns:
            Rtab, Rb = tables[R]
            op, min_real = _pair_openness(Ltab, Lb, Ladv, Rtab, Rb, step)
            k = _kern_from_openness(op, min_real, target, upm, deadband, clamp_frac, safe_frac,
                                    strength)
            if k:
                out[(L, R)] = k
    return out


def build_kerning(font, glyph_names, *, upm, reference="n", target=None,
                  deadband=None, step=10, samples=10, slope=1.0,
                  clamp_frac=0.15, safe_frac=0.20, mode=None):
    """Hitung & tulis SEED kerning class-level ke `font` (dipakai saat impor). Grouping per bentuk
    sisi; nilai per pasangan-kelas memakai model optik v3 yang SAMA dgn Smart Kerning → seed sudah
    seimbang & konsisten dgn hasil tombol Smart. Return dict laporan."""
    if deadband is None:
        deadband = _deadband(upm)
    data = {}      # n -> (contours, bounds)
    margins = {}   # n -> (tab, bounds) tabel margin cone-fill
    for n in glyph_names:
        p = _profiles(font[n])
        if p:
            data[n] = p
            tab, b = _glyph_margins(p[0], p[1], step, slope)
            if tab:
                margins[n] = (tab, b)
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

    # --- target = rhythm datar font (median pasangan lurus), jalur ukur sama dgn pasangan ---
    if target is None:
        target = _flat_target(font, upm, step, slope)

    # --- kern per pasangan kelas (eksemplar) ---
    pairs = {}
    for g1name, m1 in kern1_groups.items():
        Lname = m1[0]
        if Lname not in margins:
            continue
        Ltab, Lb = margins[Lname]
        Ladv = font[Lname].width
        for g2name, m2 in kern2_groups.items():
            Rname = m2[0]
            if Rname not in margins:
                continue
            Rtab, Rb = margins[Rname]
            op, min_real = _pair_openness(Ltab, Lb, Ladv, Rtab, Rb, step)
            k = _kern_from_openness(op, min_real, target, upm, deadband, clamp_frac, safe_frac,
                                    strength_of(mode))
            if k:
                pairs[(g1name, g2name)] = k

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
