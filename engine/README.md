# Engine — Fase 1 (Smoke Test)

Pipeline headless: **SVG → geometri bersih → UFO → fontmake → OTF/TTF → WOFF/WOFF2.**
Membuktikan bagian paling berisiko (impor + ekspor) tanpa UI. Lihat `../PRD.md` §11.

## Setup (sekali)

```bash
cd "Sensatype FontLab"
python3 -m venv .venv
source .venv/bin/activate
pip install -r engine/requirements.txt
```

> Diuji di MacBook Air M1 (arm64), Python 3.13. **Jangan** jalankan di Mac Mini server (PRD §6).

## Jalankan

```bash
source .venv/bin/activate
python engine/smoke_test.py --input svg --out build --family "Yoruna" --style Regular
```

Output di `build/`: `*.otf`, `*.ttf`, `*.woff`, `*.woff2`, `*.ufo` (format project), dan `preview.html`.

### Flag penting
| flag | default | arti |
|---|---|---|
| `--input` | `svg` | folder berisi `*.svg` |
| `--out` | `build` | folder output |
| `--upm` | `1000` | units per em (CFF/OTF default) |
| `--baseline-ratio` | `0.80` | posisi baseline dari atas viewBox (0–1) |
| `--family` / `--style` | `Sensatype Smoke` / `Regular` | name table |
| `--demo` | `Hone the engine` | teks contoh di preview.html |
| `--autospace` | off | seed spacing otomatis (HT Letterspacer, Fase 2) |
| `--reference` | self | glyph referensi zona (mis. `n`/`H`/`x`) untuk HTLS |
| `--htls-area` | `400` | HTLS paramArea ('color'/kepadatan) |
| `--htls-depth` | `15` | HTLS paramDepth (% xHeight) |
| `--htls-over` | `0` | HTLS overshoot (% xHeight) |
| `--xheight` | dari font | override xHeight (unit em) untuk HTLS |
| `--kern` | off | seed kerning Tier-1 class-level (groups.plist) |
| `--kern-reference` | `n` | glyph pasangan flat utk target celah kern |
| `--kern-target` | auto | override target celah kern (unit em) |
| `--kern-deadband` | `8` | abaikan kern di bawah nilai ini |

### Auto-spacing (Fase 2)
```bash
python engine/smoke_test.py --input svg --out build --family "Yoruna" \
    --autospace --reference n
```
`engine/htls.py` = port pure-Python HT Letterspacer (Huerta Tipografica, Apache-2.0).
Memberi **seed** sidebearing; nilai final tetap bisa di-override manual (CONTEXT D7).
Tidak ada dependensi baru (pakai fontTools).

### Seed kerning Tier-1 (Fase 2)
```bash
python engine/smoke_test.py --input svg --out build --family "Yoruna" \
    --autospace --kern --reference n
```
`engine/kerning.py` = seed kerning **class-level** (distance/area-based, Tier-1).
- Grouping per bentuk sisi → `public.kern1.*` (sisi kanan, posisi kiri) & `public.kern2.*`
  (sisi kiri, posisi kanan). Ditulis ke `groups.plist` + `kerning.plist` (§9.6: level kelas).
- fontmake/ufo2ft mengompilasi jadi GPOS PairPos fmt2 (class-based) — efisien, bukan raw pair.
- Jalankan SETELAH `--autospace` (butuh advance final). Belum: multi-master.

### Preset (Fase 2 · slot D6)
`--preset <nama>` (lihat `engine/presets.json`): `display-serif` (default), `text-serif`,
`text-sans`, `display-sans`. Tiap preset = parameter HTLS + **reference glyph per kategori**
(uppercase→H, lowercase→n, figures→zero) → spasi konsisten dalam kategori. Nilai = seed, tunable.
```bash
python engine/smoke_test.py --input glyphs --out build --family Yoruna \
    --autospace --kern --preset display-serif
```

## specimen_split.py — pecah SVG specimen → per-glyph (cikal-bakal batch-import §7)
Untuk satu SVG berisi grid karakter (mis. `Yoruna Full.svg`): pecah tiap huruf jadi
`uniXXXX.svg` (case-safe), dinormalisasi ke konvensi kanvas-tetap.
```bash
# Seluruh set karakter (141 glyph) via file layout:
python engine/specimen_split.py --input "svg/Yoruna Full.svg" --out glyphs --layout yoruna-full
python engine/smoke_test.py --input glyphs --out build --family Yoruna --autospace --kern --preset display-serif

# atau hanya baris alfabet (tanpa layout):
python engine/specimen_split.py --input "svg/Yoruna Full.svg" --out glyphs --rows upper,lower
```
- **Layout** (`engine/layouts/*.json`): tiap baris = daftar codepoint (urut posisi-x). 1 path = 1 glyph.
  `yoruna-full.json` = 6 baris / 141 glyph terverifikasi (A–Z, a–z, 0–9, simbol, tanda baca, diakritik).
- Penamaan output `uniXXXX.svg` → engine memetakan ke nama AGL (uni0041→A).
- Catatan: diakritik = spacing accent (mark-positioning = fitur lanjut); 2 codepoint kutip = asumsi.

## features.py — fitur OpenType otomatis (PRD D5)
Generate `.fea` dari konvensi NAMA glyph (tanpa editor .fea), dipanggil otomatis di `build_ufo`:
- Ligatur `f_i`/`f_f_i` → `liga`/`dlig`; Alternate `A.ss01`→`ss01`, `a.salt`/`alt`/`cvNN`→`salt`, semua→`aalt`.
- Multilingual precomposed (nama AGL `Aacute`, `eacute`) → masuk cmap otomatis. ufo2ft tetap menambah `kern`/`mark`.
- Layout specimen boleh cell BERNAMA (alt/liga/multilingual) via sidecar `_names.json` (aman kasus macOS).

## variable.py — variable font (multi-master)
`build_designspace(masters, axis, out)` (+ instances + axisLabels → **STAT & named-instances**)
+ `compile_variable(designspace, out)` → satu VF `.ttf`. `harmonize()` membuat glyph
tak-kompatibel-titik jadi STATIS (outline master default) supaya VF tetap lengkap + lapor daftarnya.
Dipakai `server/` saat ada axis + ≥2 master. Master WAJIB kompatibel interpolasi (§9.7).

### Layout penuh multi-master (`yoruna-masters.json`)
11 baris / 236 glyph: A–Z, a–z, angka+simbol, tanda baca, **alternate** (`Y.ss01`…),
**ligatur** (`R_U`, `f_f_i`…), **multilingual** (À–ž precomposed). specimen_split kini:
deteksi baris known-count (jumlah baris = layout) + **clustering glyph multi-path** (gabung
beberapa path jadi 1 glyph, mis. ligatur bobot Black). Alt/liga = KUSTOM via layout (per-font, editable).

## Konvensi SVG → glyph
Lihat `../svg/README.txt`. Ringkas: viewBox wajib; tinggi viewBox = 1 em; lebar viewBox = advance.

## Yang sudah dibuktikan
- Counter `O`/`e` berlubang (bukan hitam solid) — uji winding lolos.
- Overlap (mis. stem `n`) di-union jadi satu kontur bersih.
- Baseline & tinggi konsisten.
- Keempat format ter-generate & ter-parse ulang.
- **Belum:** 1 glyph Yoruna asli (butuh SVG dari Sensa).

## Aturan yang diterapkan (PRD §9)
Geometri dibersihkan **sekali** di sini. `picosvg.topicosvg()` menormalkan winding
even-odd → nonzero (arah hole dibalik otomatis); `skia-pathops.simplify(fix_winding=True)`
membuang overlap sambil mempertahankan lubang. Semua nilai dalam unit em.
