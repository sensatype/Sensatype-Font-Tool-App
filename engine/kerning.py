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

  3. OPENNESS (soft-min). Rata-rata terbobot-tengah dari celah TERISI, dgn celah SEMPIT dibobot
     lebih berat (rata-rata pangkat negatif, p=2) = seberapa "terbuka" pasangan secara perseptual.
     Rata-rata biasa menganggap A·T terbuka karena segitiga di atas palang T luas, lalu menyuruh
     menyusup sampai apex A nyaris menempel; mata justru membaca titik terdekat itu. Nilai kern
     dicari lewat bagi-dua (soft-min tak linier thd kern) sehingga openness = target.
     target = openness pasangan referensi LURUS (median I|I, H|H, l|l, N|N, …) — DIUKUR DENGAN
     JALUR YANG SAMA → pasangan lurus (H|H) otomatis ~0 (tak "diperbaiki" sia-sia), dan skala
     mengikuti spacing font itu sendiri (gelap/terang, rapat/lega).

  4. LANTAI ANTI-TABRAKAN, DITURUNKAN DARI FONT. Kern negatif tak boleh membuat celah NYATA
     minimum turun di bawah pinch_frac × IRAMA JEPIT font — yaitu seberapa dekat font itu sendiri
     membiarkan huruf mendekat pada pasangan lurusnya (celah tersempit I|I, H|H, n|n; lihat
     _flat_pinch). Bukan konstanta: font rapat dapat lantai rapat, font lega dapat lantai lega.
     Deadband membuang koreksi <~0.8% em (noise), clamp membatasi ekstrem.

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


# Eksponen soft-min untuk merata-ratakan celah. p=0 → rata-rata aritmetik (model lama);
# p>0 → celah SEMPIT mendominasi (rata-rata pangkat negatif, sepupu rata-rata harmonik).
#
# Kenapa perlu: rata-rata aritmetik menganggap pasangan "cukup terbuka" selama TOTAL putihnya
# banyak — tak peduli putih itu menumpuk di satu segitiga besar sementara di titik lain kedua
# huruf nyaris bersentuhan. Pada A·T, T·A, A·S segitiga di atas palang T sangat luas, jadi
# rata-rata aritmetik menyuruh menyusup dalam-dalam sampai apex A tinggal ~30 unit dari palang —
# padahal pasangan lurus font ini tak pernah lebih dekat dari ~118 unit. Mata membaca titik
# terdekat itu sebagai gelap/sesak, bukan rata-ratanya. p=2 membuat celah sempit membebani
# hitungan sehingga tuck berhenti jauh lebih awal.
#
# Sifat penting: pada pasangan berprofil RATA (H|H, o|n, m|b) semua celah hampir sama besar,
# jadi setiap nilai p memberi hasil identik — perubahan ini HANYA menyentuh pasangan berprofil
# timpang, persis yang bermasalah. Target pun diukur dgn p yang sama (lihat _flat_target), jadi
# skalanya tetap ikut font, bukan konstanta.
_PNORM = 2.0


def _soft_min_mean(ys, gaps, pnorm):
    """Rata-rata terbobot-tengah dari `gaps`, dgn celah sempit dibobot lebih berat (pnorm>0)."""
    yc = (ys[0] + ys[-1]) / 2.0
    yh = max((ys[-1] - ys[0]) / 2.0, 1.0)
    num = den = 0.0
    for i, yy in enumerate(ys):
        w = 1.0 / (1.0 + ((yy - yc) / yh) ** 2)   # bobot tengah (perseptual): pusat penuh, tepi luruh
        den += w
        if pnorm <= 0:
            num += w * gaps[i]
        else:
            num += w * max(gaps[i], 1.0) ** (-pnorm)  # celah ≤0 dijepit ke 1 → tak meledak
    if pnorm <= 0:
        return num / den
    return (num / den) ** (-1.0 / pnorm)


# Ambang "irisan terlalu tipis": irisan vertikal harus menutupi setidaknya sekian bagian dari
# glyph yang LEBIH TINGGI. Diukur thd yang lebih tinggi, bukan yang lebih pendek — kalau tidak,
# underscore (tinggi ink 20 unit) akan lolos ambang berapa pun karena irisannya menutupi hampir
# seluruh dirinya sendiri, padahal ia tak melihat 97% tinggi huruf di sebelahnya.
_THIN_OVERLAP = 0.5


def _pair_gaps(Ltab, Lb, Ladv, Rtab, Rb, step):
    """Profil celah pasangan: (ys, celah_terisi, celah_nyata_min) atau None.

    Normalnya diukur pada irisan vertikal kedua glyph. Tapi bila irisan itu cuma seiris tipis —
    underscore/tanda baca rendah/aksen lepas vs huruf penuh — jendela ukurnya jadi beberapa baris
    saja dan hasilnya tak bermakna: <2 baris → kern 0 (pasangan menganga, mis. A·_ dan _·V),
    tepat 2-3 baris → nilai liar dari sliver (mis. _·O dapat −151 tapi tetap renggang 197 unit).
    Untuk kasus itu ukuran dipindah ke GABUNGAN rentang kedua glyph, dan di ketinggian tempat
    sebuah glyph tak punya ink, margin-nya DIPEGANG pada baris terdekat miliknya (edge-hold) —
    siluetnya dianggap berlanjut lurus. Dgn begitu putih di atas underscore ikut terhitung, persis
    yang dilihat mata. Celah NYATA (utk lantai anti-tabrakan) tetap hanya dari baris tempat KEDUA
    glyph benar-benar punya ink — di ketinggian lain mereka memang tak bisa bertabrakan."""
    y0 = max(Lb[1], Rb[1])
    y1 = min(Lb[3], Rb[3])
    thin = (y1 - y0) < _THIN_OVERLAP * max(Lb[3] - Lb[1], Rb[3] - Rb[1])
    if thin:
        if not Ltab or not Rtab:
            return None
        y0 = min(Lb[1], Rb[1])
        y1 = max(Lb[3], Rb[3])
        Llo, Lhi = min(Ltab), max(Ltab)
        Rlo, Rhi = min(Rtab), max(Rtab)
    if y1 <= y0:
        return None
    ys, gapF, gapReal = [], [], []
    y = math.ceil(y0 / step) * step
    while y <= y1:
        l = Ltab.get(y); r = Rtab.get(y)
        lh = l if not thin else Ltab.get(min(max(y, Llo), Lhi))
        rh = r if not thin else Rtab.get(min(max(y, Rlo), Rhi))
        if lh and rh:
            ys.append(y)
            gapF.append((Ladv - lh[1]) + rh[3])       # celah dari margin TERISI (filledR L, filledL R)
            if l and r:
                gapReal.append((Ladv - l[0]) + r[2])  # celah NYATA (rawR L, rawL R) — hanya ink asli
        y += step
    if len(ys) < 2:
        return None
    # tak ada baris ber-ink bersama → mustahil bertabrakan → lantai tak perlu mengikat
    return ys, gapF, (min(gapReal) if gapReal else float("inf"))


def _pair_openness(Ltab, Lb, Ladv, Rtab, Rb, step, pnorm=_PNORM):
    """(openness_terisi, celah_nyata_min) — openness = seberapa terbuka pasangan secara
    perseptual (soft-min, celah sempit dominan). (None, None) bila tak beririsan."""
    pr = _pair_gaps(Ltab, Lb, Ladv, Rtab, Rb, step)
    if pr is None:
        return None, None
    ys, gapF, min_real = pr
    return _soft_min_mean(ys, gapF, pnorm), min_real


def _solve_kern(ys, gapF, target, pnorm, lo, hi):
    """k terkecil-galat sehingga openness(gapF + k) == target.

    Dgn rata-rata aritmetik dulu ini punya rumus tertutup (k = target − openness) karena
    mean(g+k) = mean(g)+k. Soft-min TIDAK linier terhadap k — menggeser semua celah sebesar k
    menggeser soft-min-nya kurang dari k — jadi nilainya dicari lewat bagi-dua. openness naik
    monoton thd k, sehingga bagi-dua selalu konvergen."""
    if _soft_min_mean(ys, gapF, pnorm) >= target:      # sudah cukup/terlalu terbuka → hanya rapatkan
        hi = min(hi, 0.0)
    for _ in range(16):                                # 16 iterasi ≈ presisi 0,02 unit pd rentang 1 em
        mid = (lo + hi) / 2.0
        if _soft_min_mean(ys, [g + mid for g in gapF], pnorm) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def _kern_from_profile(pr, target, upm, deadband, clamp_frac, floor_gap, strength=1.0,
                       pnorm=_PNORM):
    """Profil celah pasangan → nilai kern int.
    target   = openness pasangan lurus acuan (rhythm datar font, ukuran yang SAMA).
    floor_gap= celah nyata minimum yang boleh disisakan — DITURUNKAN dari font (lihat _flat_pinch).
    strength = faktor mode kerapatan (lihat MODES); 1.0 = sedang."""
    if pr is None:
        return 0
    ys, gapF, min_real = pr
    k = _solve_kern(ys, gapF, target, pnorm, -0.5 * upm, 0.5 * upm) * strength
    if k < 0:  # lantai: jangan pernah menjepit lebih rapat dari irama jepit font itu sendiri
        k = max(k, min(0.0, floor_gap - min_real))
    k = round(k)
    if abs(k) < deadband:
        return 0
    # Clamp = rel korslet, BUKAN penjaga jarak. Penjaga jarak adalah LANTAI di atas, dan lantai
    # itu sadar-bentuk sekaligus sadar-font. Clamp dulu 15% em — terlalu ketat: ia mengunci lebih
    # dulu daripada lantai pada pasangan ekstrem tanpa menambah keamanan apa pun.
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


def _flat_pinch(font, upm, step, slope):
    """IRAMA JEPIT font = seberapa dekat font ini membiarkan huruf saling mendekat pada pasangan
    LURUS-nya sendiri (celah nyata tersempit I|I, H|H, n|n, …). Inilah "mengerti setiap font":
    lantai anti-tabrakan tak lagi konstanta buatan (dulu 20% × target — pada Yoruna cuma 31 unit,
    seperempat dari 118 unit yang jadi jarak terdekat font itu sendiri), melainkan pecahan dari
    irama font yang bersangkutan. Font rapat dapat lantai rapat, font lega dapat lantai lega."""
    cand = []
    for r in _FLAT_REFS:
        if r in font and len(font[r]) > 0:
            p = _profiles(font[r])
            if not p:
                continue
            tab, b = _glyph_margins(p[0], p[1], step, slope)
            if not tab:
                continue
            _, mn = _pair_openness(tab, b, font[r].width, tab, b, step)
            if mn is not None:
                cand.append(mn)
    if cand:
        return statistics.median(cand)
    return upm * 0.10


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
    """Tanda-tangan BENTUK satu sisi (kedalaman ink dari ekstrem), terlepas dari sidebearing.

    Tanda-tangan mencakup ZONA VERTIKAL, bukan hanya profil kedalaman. Sampel di bawah diambil
    pada tinggi glyph yang DINORMALKAN (y berjalan minY→maxY), jadi profilnya buta terhadap
    seberapa tinggi glyph itu sebenarnya: batang lurus setinggi cap (H) dan batang lurus setinggi
    x (n) menghasilkan profil yang sama persis — keduanya nol semua. Akibatnya H dan n jatuh ke
    kelas kern yang sama, padahal pasangan seperti V·H dan V·n butuh nilai yang jauh berbeda:
    putih di bawah diagonal V berhenti di cap-height untuk H, tapi menganga sampai x-height untuk n.
    Menyertakan zona (minY,maxY yang dibulatkan ke kelipatan 5% em) memisahkan cap / ascender /
    x-height / descender tanpa memecah beda sepele seperti overshoot bulat.
    """
    minY, maxY = b[1], b[3]
    if maxY <= minY:
        return ("flat",)
    zone = (round(minY / (upm * 0.05)), round(maxY / (upm * 0.05)))
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
    return zone + tuple(depth)


def smart_pair(font, left, right, *, upm, step=10, slope=1.0, deadband=None,
               clamp_frac=0.22, pinch_frac=0.35, target=None, pinch=None, mode=None):
    """Kern optikal SADAR-BENTUK untuk SATU pasangan (model v3: cone-fill + openness soft-min).
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
    if pinch is None:
        pinch = _flat_pinch(font, upm, step, slope)
    Ltab, Lb = _glyph_margins(Lp[0], Lp[1], step, slope)
    Rtab, Rb = _glyph_margins(Rp[0], Rp[1], step, slope)
    pr = _pair_gaps(Ltab, Lb, font[left].width, Rtab, Rb, step)
    return _kern_from_profile(pr, target, upm, deadband, clamp_frac, pinch_frac * pinch,
                              strength_of(mode))


def flat_target(font, upm, step=10, slope=1.0):
    """Rhythm datar font (publik) — dipakai backend utk menghitung saran banyak pasangan tanpa
    mengulang kalibrasi tiap panggilan."""
    return _flat_target(font, upm, step, slope)


def auto_kern_pairs(font, names, *, upm, step=10, slope=1.0, deadband=None,
                    clamp_frac=0.22, pinch_frac=0.35, target=None, pinch=None, mode=None):
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
    if pinch is None:
        pinch = _flat_pinch(font, upm, step, slope)
    # Kerapatan pilihan pengguna = SATU-SATUNYA pengatur seberapa rapat hasilnya (dulu ada dua:
    # mode + "belajar selera" tersembunyi — membingungkan & hasilnya sulit ditebak).
    strength = strength_of(mode)
    # "Dekat" harus benar-benar terasa: tanpa ini LANTAI anti-tabrakan mengikat hampir semua
    # pasangan (terukur 85% pada font berspasi rapat) sehingga menaikkan kekuatan tak menggerakkan
    # apa pun. Saat pengguna MEMINTA lebih rapat, batasnya ikut mengalah — dgn dasar MUTLAK
    # 0,08×target (≈1,2% em) supaya glyph tak pernah benar-benar bertabrakan.
    if strength > 1.0:
        clamp_frac = clamp_frac * strength
        pinch_frac = max(0.15, pinch_frac / strength)
    floor_gap = pinch_frac * pinch
    out = {}
    for L in ns:
        Ltab, Lb = tables[L]
        Ladv = font[L].width
        for R in ns:
            Rtab, Rb = tables[R]
            pr = _pair_gaps(Ltab, Lb, Ladv, Rtab, Rb, step)
            k = _kern_from_profile(pr, target, upm, deadband, clamp_frac, floor_gap, strength)
            if k:
                out[(L, R)] = k
    return out


def build_kerning(font, glyph_names, *, upm, reference="n", target=None,
                  deadband=None, step=10, samples=10, slope=1.0,
                  clamp_frac=0.22, pinch_frac=0.35, pinch=None, mode=None):
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
    # --- lantai jepit = pecahan irama font itu sendiri (bukan konstanta) ---
    if pinch is None:
        pinch = _flat_pinch(font, upm, step, slope)
    floor_gap = pinch_frac * pinch

    # --- kern per pasangan kelas ---
    # Bentuk (openness) diukur pada EKSEMPLAR kelas, tapi lantai anti-tabrakan diukur pada anggota
    # PALING MENONJOL — anggota dgn sidebearing tersempit ke sisi yang berhadapan. Tanpa ini lantai
    # cuma melindungi eksemplarnya: anggota lain yang inknya lebih menjorok ikut memakai nilai kelas
    # itu dan bisa benar-benar bertabrakan (terukur pada braceright·less & braceright·plus).
    def _tightest(members, side):
        best, bestsb = members[0], None
        for n in members:
            if n not in margins:
                continue
            tab, b = margins[n]
            sb = (font[n].width - b[2]) if side == "right" else b[0]   # RSB / LSB
            if bestsb is None or sb < bestsb:
                best, bestsb = n, sb
        return best

    tight1 = {g: _tightest(m, "right") for g, m in kern1_groups.items()}
    tight2 = {g: _tightest(m, "left") for g, m in kern2_groups.items()}

    pairs = {}
    for g1name, m1 in kern1_groups.items():
        Lname = m1[0]
        if Lname not in margins:
            continue
        Ltab, Lb = margins[Lname]
        Ladv = font[Lname].width
        Lt2 = margins.get(tight1[g1name])
        for g2name, m2 in kern2_groups.items():
            Rname = m2[0]
            if Rname not in margins:
                continue
            Rtab, Rb = margins[Rname]
            pr = _pair_gaps(Ltab, Lb, Ladv, Rtab, Rb, step)
            if pr is not None and Lt2 is not None:
                Rt2 = margins.get(tight2[g2name])
                if Rt2 is not None and (tight1[g1name] != Lname or tight2[g2name] != Rname):
                    worst = _pair_gaps(Lt2[0], Lt2[1], font[tight1[g1name]].width,
                                       Rt2[0], Rt2[1], step)
                    if worst is not None and worst[2] < pr[2]:
                        pr = (pr[0], pr[1], worst[2])   # pakai jepit anggota terburuk
            k = _kern_from_profile(pr, target, upm, deadband, clamp_frac, floor_gap,
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
