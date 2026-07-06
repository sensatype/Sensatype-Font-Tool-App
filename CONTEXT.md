# CONTEXT — Sensatype Font Tool

> Dokumen hidup untuk melacak progres, keputusan, dan status.
> Baca PRD.md untuk gambaran utuh & arsitektur. Dokumen ini = "di mana kita sekarang".
> Update setiap akhir sesi.

**Status proyek:** BUILD — Fase 1 & 2 selesai (tervalidasi Yoruna 141 glyph); Fase 3 UI core jalan
**Fase aktif berikutnya:** Polish Fase 3 (variable font/masters, mark-positioning) → Fase 4 Electron
**Terakhir diperbarui:** 2026-06-29

---

## Status fase

| Fase | Deskripsi | Status |
|---|---|---|
| 0 | Perencanaan arsitektur & scope | ✅ Selesai |
| 1 | Engine smoke test (Python CLI: SVG → 4 format) | ✅ Engine lolos (sintetis + "H" Yoruna asli); sisa: validasi baseline re-export |
| 2 | Glyph asli + auto-spacing (HTLS) + seed kerning Tier-1 + preset | ✅ Tervalidasi pada 52 glyph Yoruna asli (A–Z/a–z): split, baseline, spacing per-kategori, kerning class-based |
| 3 | UI di browser (React/Vite + API Python lokal) | 🟡 Core loop + fitur OT (liga/alt/multilingual) + infrastruktur variable font jalan |
| 4 | Pembungkusan Electron (distribusi) | ⬜ Belum mulai |

---

## Fokus saat ini → Fase 1: Engine smoke test

**Tujuan:** membuktikan bagian paling berisiko (impor-bersihkan-geometri + ekspor) dengan biaya nyaris nol, tanpa UI apa pun.

**Bentuk:** satu skrip Python CLI headless. Beberapa SVG masuk → OTF/TTF/WOFF/WOFF2 keluar → install → ketik.

**Langkah teknis di dalam skrip:**
1. Parse SVG (picosvg untuk normalisasi).
2. Y-flip + petakan ke UPM (mis. 1000).
3. Union kontur via skia-pathops (perbaiki winding + buang overlap sekaligus).
4. Bangun UFO (ufoLib2): glyph + advance width + cmap.
5. Kompilasi via fontmake → OTF + TTF.
6. fontTools → WOFF + WOFF2.

**Mulai dari:** H, O, n, e (sederhana). Lalu 1 glyph Yoruna asli sebagai edge case.

**Checklist lolos:**
- [x] Counter "o"/"e" berlubang (BUKAN hitam solid). — terbukti render piksel + arah kontur CCW/CW.
- [x] Huruf di baseline, tinggi konsisten.
- [x] 4 format terbuka & merender. — OTF/TTF/WOFF/WOFF2 ter-generate & ter-parse ulang.
- [x] 1 glyph Yoruna asli lolos. — "H" Yoruna (Didone) → 4 format, kurva mulus, winding benar.
      Catatan: penempatan vertikal awal salah karena export crop-ketat; KONVENSI dikunci →
      kanvas tetap (tinggi=em) + baseline guide (lihat `svg/README.txt`). Re-export untuk
      validasi baseline final H/O/n/e.

> Catatan: 3 item pertama dibuktikan dengan SVG sintetis throwaway (H/O/n/e). Engine
> & toolchain terkonfirmasi di MacBook Air M1 / Python 3.13. Tinggal validasi edge case Yoruna.

**Implementasi:** `engine/smoke_test.py` (+ `engine/requirements.txt`, `engine/README.md`).
Drop SVG ke `svg/`, output ke `build/`. Konvensi penamaan & koordinat: `svg/README.txt`.

**Mesin:** MacBook Air M1, venv lokal. JANGAN di Mac Mini server.

---

## Log keputusan

| # | Keputusan | Alasan |
|---|---|---|
| D1 | Engine = Python (fontTools/fontmake), bukan murni JS | Ekosistem JS tidak punya padanan fontmake/pathops yang andal → risiko silent corruption. |
| D2 | UFO sebagai format project (bukan sekadar intermediate) | Menghapus oper-operan OTF antar app = inti penghapusan "kerja dua kali". Format terbuka = kemandirian. |
| D3 | Electron sebagai shell | Konsistensi rendering + selaras Node.js (preferensi Sensa). Hanya pembungkus distribusi, langkah terakhir. |
| D4 | TIDAK ada editor outline | Desain terjadi di vector app (upstream). Melompati ~60% kerumitan FontLab. |
| D5 | TIDAK ada editor `.fea` di v1 | Feature di-generate otomatis. IDE feature = fase 2. |
| D6 | Auto-assist tanpa Gemma di v1 | Gemma hanya memilih preset (node termurah). Diganti dropdown manual — deterministik, nol GPU, nol risiko salah klasifikasi. Sensa tahu kategori font-nya sendiri. Gemma jadi drop-in masa depan untuk batch besar. |
| D7 | Spacing & kerning: auto seed + manual override | Auto memberi seed, manual yang memutuskan. Bukan dua mode bersaing — satu alur. |
| D8 | Kerning level kelas sejak hari 1 | Raw pair = jurang n² yang bikin mangkrak. groups.plist. |
| D9 | Kerning Tier-1 saja (jangan Tier-2/iKern) | Tuning visual Tier-2 sangat mahal; seed + finishing manual lebih cepat total. |
| D10 | Dev/test di browser, bukan Electron | Electron = pembungkus akhir. UI dites via Vite + API lokal (pola stack Mac Mini). |
| D11 | De-risk dulu: engine sebelum UI | Risiko ada di Python. Membangun UI sebelum engine = memoles kemudi untuk mesin yang belum tentu menyala. |

---

## Aturan korektness (JANGAN DILANGGAR — ringkas; detail di PRD §9)

1. Bersihkan geometri **sekali** saat impor. Auto-assist & preview pakai outline bersih, bukan SVG mentah.
2. SVG = Y-down/evenodd → Font = Y-up/nonzero. Compound path (o/a/e) = zona bahaya winding.
3. skia-pathops union = perbaiki winding + buang overlap dalam satu operasi.
4. Kontrol manual = translasi saja, tidak menderivasi ulang bentuk di JS. Preview = final.
5. Nilai UI = unit em, konsisten UPM.
6. Kerning → level kelas (groups.plist), bukan raw pair.
7. Kerning group wajib kompatibel di semua master (kalau tidak, interpolasi pecah).

---

## Spesifikasi kontrol manual (untuk Fase 3)

- **Spacing (LSB/RSB per glyph):** drag handle di canvas (rasa visual) **+** input angka (presisi & konsistensi antar glyph). Keduanya wajib.
- **Kerning (per pasangan):** slider **+** input angka di samping string preview live (mis. ketik "AVA", "To"). Sediakan input angka karena sering butuh nilai negatif spesifik.
- Manual kerning menulis ke **kelas**, bukan pasangan persis.
- Semua nilai beroperasi di **unit em**.
- Data tertulis ke UFO: spacing di `.glif`, kerning di `kerning.plist` + `groups.plist`.

---

## Pertanyaan terbuka / belum diputuskan

- [x] Skema penamaan file SVG → Unicode (Fase 1): `A.svg` (ASCII), `uni0041.svg`/`u1E00.svg` (hex eksplisit), nama lain → PUA auto. Mode batch = fase berikut.
- [x] UPM target: **1000** (CFF/OTF) dikonfirmasi sebagai default.
- [x] Detail seed autospacing: parameter HTLS per preset → `engine/presets.json` (area/depth/over + ref per kategori). Nilai = seed, tunable.
- [x] Daftar preset awal → display-serif (default), text-serif, text-sans, display-sans di `engine/presets.json`.
- [x] Variable font: axis + designspace + compile VF + STAT + named-instances SUDAH (`engine/variable.py`).
- [ ] Nama produk final aplikasi.

---

## Catatan untuk sesi berikutnya

Skrip smoke test Fase 1 SUDAH dibuat & terbukti (`engine/smoke_test.py`).

⚠ Temuan: `Yoruna.svg` di root proyek BUKAN satu glyph — itu **poster specimen**
(label seksi sebagai `<text>` hidup: UPPERCASE/LOWERCASE/LIGATURE/MULTILINGUAL/dst.,
3 JPEG tertanam, 3000+ path semua glyph dalam layout rapat). Tidak bisa dipakai untuk
smoke test glyph-tunggal; ekstraksi otomatis kalah oleh layout rapat. Engine TERBUKTI bisa
menelan kurva Yoruna asli (px-unit + bezier Affinity) → 4 format, tapi shape yang terambil
cuma kotak latar.

Pengerasan importer dari sesi ini (tetap dipakai): sanitasi satuan `px`/`pt`;
`topicosvg(drop_unsupported=True)` buang elemen non-outline; fallback anggun kalau
`skia.simplify` gagal.

Fase 2 (auto-spacing) SUDAH dimulai & inti-nya jalan:
- `engine/htls.py` = port pure-Python HT Letterspacer (Huerta Tipografica, Apache-2.0) untuk UFO.
  Diport: scanline margins, depth-limit, polygon area (shoelace), normalisasi area→sidebearing.
  TIDAK diport (fase berikut): rules/preset per kategori, komponen, metric-keys, stroke-expand.
- Integrasi: flag `--autospace` di `engine/smoke_test.py` (+ `--reference`, `--htls-area/-depth/-over`,
  `--xheight`). Seed ditulis ke UFO sebelum fontmake. Laporan sebelum→sesudah dicetak.
- Verifikasi sintetis: glyph simetris (H,O) dapat sidebearing simetris (sanity ✓); render
  "HOnenOH" jelas lebih rapat & ritme rata dibanding sebelum spacing.

Seed kerning Tier-1 (class-level) JUGA jalan & terverifikasi:
- `engine/kerning.py` = distance-based yang BENAR (rata-rata celah berhadapan, bukan jarak titik
  → bulat ditangani benar). Grouping per bentuk sisi → public.kern1 (sisi kanan) / public.kern2
  (sisi kiri). Tulis ke groups.plist + kerning.plist (LEVEL KELAS, §9.6).
- Flag `--kern` (+ `--kern-reference`, `--kern-target`, `--kern-deadband`) di smoke_test.py.
- Terverifikasi di GPOS: PairPos format 2 (class-based), nilai cocok (O|O −48, O|{H,n} −24, …);
  ufo2ft otomatis menggabung {H,n}. Pasangan flat (n|n) ~0 (deadband) = benar.
- Catatan §9.7 (kerning kompatibel antar-master) baru relevan saat variable font (Fase lanjut).

Preset & specimen-split SUDAH dibuat & tervalidasi pada Yoruna asli:
- `engine/presets.json` + `engine/presets.py` = slot preset D6. Preset awal: display-serif (default,
  utk Yoruna Didone), text-serif, text-sans, display-sans. Tiap preset = parameter HTLS +
  reference glyph PER KATEGORI (uppercase→H, lowercase→n, figures→zero). Flag `--preset`.
  Drop-in masa depan: Gemma cukup memilih nama preset (D6).
- `engine/specimen_split.py` = pecah SVG specimen grid → per-glyph `uniXXXX.svg` (cikal-bakal
  batch-import §7). Mendukung **seluruh baris** lewat file layout (`--layout`).
  - `engine/layouts/yoruna-full.json` = layout terverifikasi (by-render) untuk "Yoruna Full.svg":
    6 baris, **141 glyph** (A–Z, a–z, 0–9, simbol/mata-uang/ligatur, tanda baca, diakritik).
    Tiap baris = codepoint urut posisi-x; 1 path = 1 glyph (terbukti utk semua baris).
  - Hasil: 141 glyph → split benar, baseline konsisten semua baris, 4 format jadi (lihat `build/`).
  - Kutip idx 50/52 = `quotesingle`(0027)/`quotedbl`(0022) — TERVERIFIKASI via render (digambar
    keriting identik dgn 2019/201D, pola desain standar). Layout final, tidak ambigu lagi.
  - Diakritik (baris 4–5) diimpor sebagai **spacing accent** (advance biasa); urutan diambil dari
    geometri render (caron sebelum circumflex). Mark-positioning (anchor/`mark`/`mkmk`) = fitur Fase lanjut.
- Validasi: 52 glyph Yoruna (A–Z+a–z) → split benar 100%, baseline konsisten (descender turun,
  bulat overshoot), spacing per-kategori (H=63/63, A=21/22 dst.), kerning class-based di GPOS,
  keempat format jadi. Output ada di `build/` (preview.html).
- Engine: nama glyph `uniXXXX` kini dipetakan ke nama AGL (uni0041→A) — case-safe di macOS.

Alur pakai untuk specimen penuh (141 glyph):
  python engine/specimen_split.py --input "svg/Yoruna Full.svg" --out <dir> --layout yoruna-full
  python engine/smoke_test.py --input <dir> --out build --family Yoruna --autospace --kern --preset display-serif

Fase 3 (UI) — core loop SUDAH jalan & tervalidasi di browser:
- `server/` = API lokal FastAPI (`server/app.py` + `server/project.py`) membungkus engine.
  Endpoint: import specimen/glyphs, /project, /glyph/{n} (outline+metrik), PATCH spacing,
  PUT kerning (class-level), PUT metadata, POST respace (ganti preset), GET export (zip 4 format),
  GET preview.woff2 (utk @font-face). Project = UFO + project.json + preview.woff2 di server/workspace/.
- `app/` = React + Vite + TS + Tailwind v4, tema dark pro, komponen kustom (lucide icons).
  Layar: Import (drag-drop specimen+layout / multi-SVG) → TopBar (preset/re-seed/export) →
  GlyphGrid (render live @font-face) → GlyphEditor (kanvas SVG, bar sidebearing draggable + input angka)
  → PreviewBar (teks live) → SidePanels (Kerning class-level + Metadata form).
  Edit → backend recompile preview.woff2 → font di-reload (FontFace API).
- Tervalidasi: import Yoruna 141 glyph, edit spacing/kerning live, export zip 4 format. Tanpa error konsol.
- Jalankan: `uvicorn server.app:app --port 8000` + `cd app && npm run dev` (lihat README.md).

Fitur OpenType (Alternate/Ligature/Multilingual) — SUDAH (engine+backend+UI):
- `engine/features.py` = generate .fea dari konvensi NAMA glyph (PRD D5, auto, tanpa editor .fea):
  ligatur `f_i`→`liga`/`dlig` (urut komponen terbanyak dulu), alternate `A.ss01`→`ssNN`,
  `a.salt`/`alt`/`cvNN`→`salt`, semua→`aalt`. Multilingual precomposed (Aacute…) via cmap (nama AGL).
  ufo2ft tetap menambah `kern`/`mark` otomatis. Ditulis ke font.features.text (build_ufo flag `features`).
- `name_and_codepoint` diperluas: `.`-suffix=alternate, `_`=ligatur (tanpa unicode), nama AGL→unicode.
- specimen layout kini boleh cell BERNAMA (alt/liga/multilingual) via sidecar `_names.json`
  (aman tabrakan-kasus macOS). Cell codepoint pakai `0x..`/hex; cell nama = string lain.
- UI: tab "Fitur" (lihat liga/alt/ss terdeteksi + toggle font-feature-settings di preview).
- Terverifikasi: GSUB liga/ss01/salt/aalt + cmap Aacute (U+00C1), GPOS kern tetap ada.

Variable font — INFRASTRUKTUR jalan (master kedua menyusul, sesuai keputusan):
- `engine/variable.py` = build designspace (fontTools.designspaceLib) + compile VF (fontmake -o variable).
- `server/project.py` multi-master: project.json simpan `axis` + `masters[]`; master0=project.ufo,
  master tambahan di `masters/mN/master.ufo`. Endpoint PUT /api/axis, POST /api/master.
  compile_preview & export jadi VF saat axis + ≥2 master (preview.woff2 = VF; export = VF .ttf+.woff2).
- UI: tab "VF" (set axis, daftar masters, tambah master, slider axis). Slider → `font-variation-settings`
  di grid & preview teks (browser render VF langsung). Terverifikasi: fvar wght 400–700, slider apply.
- CATATAN: master harus KOMPATIBEL interpolasi (§9.7). STAT table & named-instance: nanti.

VARIABLE FONT NYATA SUDAH JALAN (3 master Yoruna Thin/Regular/Black):
- File: `svg/Yoruna Thin.svg` (100), `Yoruna Regular.svg` (400), `Yoruna Black.svg` (900).
- Alur app: import Regular (upper,lower) → set axis wght 100–900 → add master Thin@100, Black@900.
- Interpolasi terbukti (stem 'l': 51→114→200) & live di UI (slider menggerakkan grid + preview).
- KOMPATIBILITAS: import SVG (picosvg+simplify) menghasilkan struktur titik sedikit beda per bobot
  → 35/52 glyph kompatibel, 17 tidak (K Q R Y Z a d e g k p s u v w y z). `variable.harmonize()`
  membuat glyph tak-kompatibel STATIS (outline master default disalin → delta nol) supaya VF tetap
  lengkap; daftar statis dilaporkan ke UI (`staticGlyphs`). Perbaikan sebenarnya = samakan struktur
  titik di sumber (tugas desain) atau importer yang menjaga korespondensi titik (riset).
- BELUM dari 3 master ini: baris alternate/ligature/multilingual (perlu full-layout + clustering
  multi-path; baris ligatur Black = 25 path utk 14 glyph). Engine fitur OT-nya SUDAH siap (terverifikasi);
  alt/liga/multilingual bisa dipakai SEKARANG via file SVG bernama terpisah (A.ss01/f_i/Aacute).

UPDATE — FULL FONT dari 3 specimen lengkap SUDAH JALAN (alt/liga/multilingual + STAT + instances):
- `engine/layouts/yoruna-masters.json` = layout 11-baris / 236 glyph terverifikasi by-render:
  A–Z, a–z, angka+simbol, tanda baca+mark, **alt kapital** (Y/A/D/M/N/B/O → `.ss01`),
  **alt minuscule** (g/a/a/e/o → `.ss01`/`.ss02`), **ligatur Yoruna** (RU…OA → `R_U`…`O_A`),
  **f-ligatur** (ff…ft → `f_f`…`f_t`), **multilingual** À–Ž / à–ž (precomposed).
- `specimen_split` kini: (a) deteksi baris known-count (jumlah baris = layout) via gap-y terbesar;
  (b) clustering glyph known-count → tangani MULTI-PATH (gabung beberapa path jadi 1 glyph SVG).
- STAT + named-instances: `variable.build_designspace` menambah instances + axisLabels →
  fvar named-instances (Thin/Regular/Black) + tabel STAT.
- Terverifikasi (app, 3 master): 239 glyph; GSUB aalt/dlig/liga/ss01/ss02; cmap multilingual (É,ñ,Š,ž);
  fvar instances Regular/Thin/Black; STAT; interpolasi (l stem 51/114/200); **107 glyph statis**
  (tak-kompatibel titik → di-harmonize). Kerning class-level → 21006 pasangan (besar; perlu prune nanti).
- "Custom" alt/liga: didefinisikan di LAYOUT (per-font, editable). Belum: UI rename/assign fitur interaktif.

PREVIEW langkah-2 = KANVAS SPECIMEN + GARIS METRIK (ganti grid bernomor):
- `extract_shapes` kini kembalikan shape MENTAH (koordinat asli SVG) + garis panduan baseline/cap
  per baris (auto, editable) + viewBox. Normalisasi vertikal TIDAK lagi otomatis saat ekstrak.
- `commit_import` menormalisasi tiap glyph PAKAI GARIS: baseline = garis baseline terdekat ke dasar
  glyph, cap = garis cap di atasnya; scale = cap_target/(baseline−cap), dasar baris → baseY. (Garis =
  kontrol ekstraksi, bukan sekadar visual.)
- Backend: staging simpan shapes(mentah)+guides+viewBox; endpoint POST /api/import/staging/guides
  (`set_guides`, frontend kirim full list tiap perubahan).
- UI `SpecimenCanvas.tsx`: SVG viewBox specimen, render glyph di posisi asli + garis base(merah)/
  cap(biru) per baris. Seret garis = atur; **Alt/Option-seret = salin garis** (taruh pasangan per baris);
  Delete = hapus; klik glyph = pilih (buang/gabung/pisah di kanvas). Tombol tambah Baseline/Cap.
  Catatan teknis: edit garis pakai `guidesRef` yang di-update SEGERA (bukan nunggu re-render) supaya
  commit tak pakai state stale. Terverifikasi: drag, Alt-copy, delete, commit semua jalan.
- Tambahan kanvas: ZOOM (tombol +/−/reset + Ctrl/⌘+scroll, 50–600%), UNDO/REDO (history staging
  di backend `_snapshot`/`staging_undo`/`staging_redo`, endpoint /undo /redo, tombol + ⌘Z/⌘⇧Z;
  staging_state kirim canUndo/canRedo), MULTI-SELECT garis (Shift-klik toggle, seret/hapus/Alt-copy
  semua yang terpilih sekaligus). Terverifikasi: zoom 900→1129px, multi-select 2, delete 24→22, undo→24.
- Penyempurnaan kanvas: (a) viewBox diberi padding atas/bawah (vh*0.06) supaya garis cap uppercase
  (kadang y<0) & descender terlihat/bisa diatur; (b) zoom MULUS (faktor kontinu exp(-deltaY*0.0015));
  (c) zoom KE KURSOR (zoomAt simpan fokus, scroll disesuaikan di useLayoutEffect; layout w-fit+mx-auto
  agar tetap bisa scroll saat di-zoom). Terverifikasi: titik di bawah kursor tetap (frac 0.772→0.772).
- REWORK zoom kanvas (bukan halaman): viewport TETAP (overflow hidden) + konten di-CSS-transform
  `translate3d+scale` (`will-change:transform` → GPU-composited, mulus, tanpa reflow). Listener wheel
  NON-PASIF (addEventListener passive:false + preventDefault) → ctrl/⌘-scroll zoom DI KANVAS, browser
  tak ikut zoom halaman; scroll biasa = pan. Zoom-ke-kursor murni-matematis (newPan=cur−(cur−pan)·ratio).
  Maks zoom 1000% (MAX_Z=10). Guide-drag pakai upp via getBoundingClientRect (ikut skala transform).
  Terverifikasi: zoom 100→1000% (capped), pan via scroll, zoom-ke-kursor, guide-drag tetap jalan, tanpa error.
- Seleksi glyph ala Affinity/Figma di kanvas Bersihkan: (a) MARQUEE — seret area kosong = kotak seleksi
  (border+isi aksen) + badge "N objek" dekat kursor; glyph yang ter-sentuh kotak terpilih (idsInRect via
  svg.getScreenCTM().inverse(), uji interseksi bbox). (b) klik glyph = pilih tunggal, Shift-klik = tambah/kurang.
  (c) klik area KOSONG = batal pilih semua (glyph + garis). State machine pointer di contRef (dragKind:
  'guide'|'marquee') route ke guide-drag vs marquee; glyph pakai data-shape-id (hit via closest), TANPA
  handler per-shape. SpecimenCanvas kini terima setSel (bukan onToggle). PENTING: klik-tunggal garis baseline/
  cap kini MENETAP terpilih (dulu hilang karena onClick background meng-clear & commit menetapkan-ulang id):
  guide commit (onGuides) HANYA bila benar2 digeser (moved>0.5px) atau alt-copy — klik pilih saja tidak commit.
  Terverifikasi: marquee 39 objek + badge, klik-tunggal garis tetap (1), shift garis (2), geser garis commit
  (147→318), klik kosong batal (0), tanpa error konsol.
- GlyphEditor (mode Spasi) — 3 perbaikan: (a) GLYPH DIAM saat LSB/RSB ditarik (dulu outline di-translate(shift)
  sehingga seluruh huruf ikut geser). Model baru: glyph digambar di koordinat asli; bar kiri = origin di
  (xLeft − lsb), bar kanan = advance di (xRight + rsb); onMove bar kiri pakai (lsb − dx) [geser kanan = LSB
  turun], bar kanan tetap (rsb + dx). viewBox berbasis d.lsb/d.rsb AWAL → frame tetap, glyph tak zoom/geser.
  (b) GARIS METRIK horizontal dibatasi ke area glyph [leftBarX−over .. rightBarX+over] (over=vw*0.03), tak lagi
  selebar padded-canvas; label ikut ke lineX1. frameTop=upm*1.0, frameBottom=−upm*0.3 (sedikit lebih rapat).
  (c) KOLOM NILAI metrik vertikal di bar bawah: Base(0,disabled) · Cap · x · Asc · Desc → commitMetric(key,v)
  via api.setMetrics (font-wide). Num kini punya prop compact (!w-16) & disabled. Bar bawah flex-wrap.
  Terverifikasi: drag LSB → glyph diam (gerak 0px, kiri 414 tetap sebelum/sesudah commit), LSB 90→272 berubah;
  garis horizontal −29.9→608.9 (bukan −180→817); setMetrics capHeight 660 tersimpan & terbaca; tanpa error.
- GlyphEditor lanjutan: (a) BAR/GARIS dari METRIK bukan titik mentah → bar kiri=origin(xMinV−lsb, xMinV=d.lsb),
  bar kanan=advance(xMaxV+rsb, xMaxV=d.advance−d.rsb). Fix bug: glyph yg menjorok keluar advance (mis. '?'
  advance 344 tapi outline s/d 637) dulu menaruh bar kanan di 579; kini tepat di advance. Garis metrik tetap
  [leftBarX−over..rightBarX+over], over=vw*0.025. Framing vw cakup extent nyata glyph (max(advance,gxMax)).
  (b) ZOOM ke kursor (scrollRef + pendingZoom + useLayoutEffect, wheel non-pasif ⌘/ctrl, 30%–800%, baseW=460,
  w-fit mx-auto, tombol −/100%/+/reset; resetView juga memusatkan scroll). (c) UNDO/REDO per-glyph: hist refs
  (Snap={contours,lsb,rsb,asc,desc,cap,x}), pushHist tiap commit (space/outline/metric/guide), applySnap via
  setOutline+setSpacing+setMetrics (applying flag agar tak push saat apply); tombol header + ⌘Z/⌘⇧Z/⌘Y.
  (d) BASELINE bisa diatur: garis base (key=null) kini draggable (startBase) → menggeser SELURUH outline
  vertikal (commitOutline), + kolom "Base ±" (nudge em, + naik). Label metrik dipindah keluar flip (1 svg).
  Terverifikasi: bar A di origin0/advance579; garis A −24.9→603.9; zoom 100→156%+; baseline drag y 0→−130
  commit; undo: spacing 108→90 lalu baseline −130→0 (kembali asli), redo memulihkan; tanpa error.
- GlyphEditor fix zoom: (a) ⌘(Mac)/Ctrl(Win)+scroll dulu TIDAK men-zoom — listener wheel dipasang di
  useEffect([]) yang jalan saat mount pertama ketika d masih null (tampilan "Memuat…"), scrollRef belum ada
  → bail. Solusi: pasang via CALLBACK-REF (setScroll) yang attach/detach listener tepat saat div kanvas
  mount + re-attach saat ganti glyph; hapus useEffect wheel (juga buang warning "deps size changed").
  (b) Tombol zoom dulu ikut bergeser saat scroll/zoom karena absolute DI DALAM kontainer overflow-auto.
  Solusi: bungkus area scroll dgn wrapper relatif non-scroll; tombol zoom jadi sibling di luar scroll
  (absolute thd wrapper). Terverifikasi: ⌘ 143%, Ctrl 205%, scroll biasa tetap (pan); tombol zoom
  insideScroll=false & bergerak 0px saat kanvas di-scroll 939px; tanpa error konsol.
- GlyphEditor — node & handle (terinspirasi Affinity Designer 2):
  (a) UKURAN node/handle PROPORSIONAL zoom: nodeR=vw*0.0085/zoom, handleR=nodeR*0.72, stroke /zoom →
  ukuran ikon KONSTAN di layar (terverif: r 6.33→3.08 saat zoom 205%).
  (b) On-curve: smooth=false→KOTAK (sudut, handle independen), smooth=true→LINGKARAN (halus); off-curve
  handle=lingkaran kecil. Tombol toggle "Jadikan halus/sudut" (selIsOn); saat→halus, kedua handle
  diluruskan collinear. Backend round-trip `smooth` OK (glyph_svg & set_outline).
  (c) HANDLE TERIKAT pada node halus: seret 1 handle → handle lawan ikut collinear (sisi berlawanan,
  panjang dipertahankan) via startNode menangkap anchor+oppIdx+oppDist (terverif: titik di prediksi ada).
  (d) SHIFT+seret handle = snap sudut ke 45° dari anchor (snap45); terverif sudut 44.9°.
  (e) Seret node on-curve membawa handle yang menempel; node-drag commit hanya bila moved (klik=pilih saja).
  (f) Titik hasil split (addNode) ditandai smooth.
- Backend ROBUSTNESS: `set_outline`/`set_spacing`/`set_metrics`/`set_kerning`/`set_metadata`/`compile_static`/
  `respace`/`commit_import`/`add_master` dibungkus decorator `@_locked` (self._write_lock=threading.RLock) —
  FastAPI sync endpoint jalan di threadpool; save UFO BERSAMAAN bisa MERUSAK UFO (lib.plist/glyphOrder hilang
  → state() 0 glif). Terjadi sekali saat test agresif; dipulihkan dgn rebuild public.glyphOrder via ufoLib2.
  Terverif: 10 write paralel → UFO tetap utuh (199 glif). CATATAN: undo TIDAK push-history bila dipicu saat
  applySnap masih jalan (applying=true) — perilaku benar; di pemakaian normal (edit sekuensial) aman.
- GlyphEditor — SNAPPING ke grid: state snapOn (default off) + snapStep (default 10, em); helper
  snap1(v)=Math.round(v/step)*step (step=1 bila off → integer). Diterapkan ke SEMUA drag: node, handle
  (kecuali Shift=45° diprioritaskan), bar LSB/RSB, garis metrik, baseline. Untuk node on-curve, POSISI
  di-snap (bukan delta) → node mendarat di grid, handle ikut delta sama. Kontrol di header: tombol Magnet
  (toggle) + input nilai grid. Handle off-curve diperbesar (rasio 0.72→0.86). Terverif: grid 50 → posisi
  kelipatan 50 (x1100,y700), off → bebas (x1271). CATATAN PENTING: jangan uji-drag destruktif di glyph
  ASLI user — test agresif sempat menggeser beberapa handle 'O' (lalu direkonstruksi via elips k=0.5523).
- GlyphEditor — FIX bug bar LSB/RSB revert: dulu `xMinV=d.lsb`, `xMaxV=d.advance-d.rsb` dihitung dari `d`
  yang BERUBAH saat commit spasi (server menggeser glyph), padahal glyph KLIEN diam → bar lompat/balik ke
  origin setelah commit. Solusi: simpan tepi VISUAL stabil di ref `bbox0={xMin,xMax}`, di-set saat glyph
  load (g.lsb, g.advance-g.rsb) & saat commit OUTLINE (res), TAPI tidak saat commit spasi. xMinV/xMaxV baca
  bbox0 → leftBarX=bbox0.xMin-lsb, rightBarX=bbox0.xMax+rsb tetap di posisi yang diatur. Terverif (H): bar
  LSB 537→492 TETAP 492 sesudah commit (dulu balik 537); bar RSB tetap; lsb/rsb berubah benar.
  Baseline snapping: SUDAH jalan (snap1 pada g.dy) — shift di-snap ke kelipatan grid (mis. −100 dgn step 50).
  KETERBATASAN diketahui (model 'glyph diam'): set_spacing menggeser glyph di SERVER tapi kontur KLIEN tetap;
  bila user ubah spasi LALU edit node, set_outline me-recompute lsb dari kontur klien → perubahan spasi bisa
  hilang. Belum diperbaiki (butuh preserve-spasi/viewBox-compensation; alur ini jarang: spasi biasanya finishing).
- GlyphEditor — baseline snapping "nempel": dulu garis base DIAM (hanya glyph yang bergeser) → snap tak
  terasa. Kini garis baseline IKUT bergerak & snap ke grid saat diseret (state baseLineY = g.dy snapped;
  garis+label dirender di y=baseLineY; glyph tetap ikut bergeser sama). Reset baseLineY=0 saat lepas/ganti
  glyph (baseline kembali ke 0, glyph simpan shift). Konsisten dgn garis cap/x/asc/desc yang juga bergerak+snap.
  Terverif (H, grid 50): garis y saat seret = [-50,-100,-250,-350] (kelipatan 50), reset 0 saat lepas.
- GlyphEditor — PERFORMA (lag drag di zoom tinggi): (a) GPU — SVG dirender ukuran DASAR (baseW=460,
  baseSvgH=baseW*vh/vw) lalu di-`transform: scale(zoom)` (origin top-left, will-change:transform); wrapper
  div memesan ukuran ter-skala (baseW*zoom) utk scroll. Dulu pakai CSS width=baseW*zoom → SVG raster ulang di
  ukuran besar (3680px @ 800%) tiap pointermove. Tajam di zoom normal (Chrome raster di skala efektif).
  (b) THROTTLE rAF — update kontur saat drag (node/base) dikoalisi 1×/frame via requestAnimationFrame
  (applyContours; contoursRef di-set langsung utk commit; baris sinkron contoursRef dijaga `if(!drag.current)`;
  rAF dibatalkan+flush di onUp). Kurangi re-render dari >100/dtk → 60/dtk. Terverif drag node tetap benar.
  Kerning lag = inheren (set_kerning → compile_static recompile penuh tiap commit slider/onMouseUp); GPU transform
  mengurangi re-raster editor saat App re-render (bumpFont). Opsi lanjut: preview kerning berbasis SVG (instan,
  tanpa recompile) — belum dibuat.
- RESTORE glyph rusak dari SUMBER: server/workspace/glyphs/gXXXX.svg (peta _names.json) = SVG NORMALISASI asli
  (pra-edit). Rebuild via smoke_test.build_ufo([gXXXX.svg], tmp, autospace=True, preset) → ambil outline → PATCH
  /api/glyph/<name>/outline. Dipakai memulihkan 'O' (g0014) PERSIS (rekonstruksi elips manual sebelumnya SALAH:
  outer jadi elips sempurna tak cocok counter → sabit). INI cara restore yang benar.
- GlyphEditor — REWORK ke VIEWBOX (render hanya area terlihat, seperti Affinity/game): SVG ukuran TETAP
  (width/height 100% = piksel layar, mis. 353×461) → raster KONSTAN di zoom berapa pun (di 1200% tetap 353px,
  bukan 5520px). zoom/pan via VIEWBOX, bukan CSS width/transform. State view={fx,fy,zoom} (fx/fy=pusat fraksi
  frame konten). vbW=fitW/zoom (fitW=max(vw, vh*aspekElemen)), vbH=vbW/aspek, vbX/vbY dari pusat. preserveAspect
  ="none" (aspek viewBox=elemen → tanpa distorsi). elem diukur via ResizeObserver (callback-ref svgCb yang juga
  pasang listener wheel non-pasif). frameRef simpan {vx,vw,vh} utk listener. upp()=vbW/svgPixelW (ikut zoom).
  onDouble: fx=vbX+(cx-rect.left)*upp, fy=frameTop-(vbY+(cy-rect.top)*upp). Formula ukuran (nodeR=vw*..../zoom,
  stroke) TETAP — tetap konstan di layar di model ini. Tajam (vektor di resolusi elemen), bukan blur.
  Terverif: SVG 353px tetap di 1200%; bar LSB drag 40px→ΔLSB 113 (=40×upp 2.82), bar tetap; zoom/pan/render OK.
- KerningPanel — preview INSTAN: ganti preview berbasis-font (butuh recompile) dgn SVG dari PATH glyph
  (KernPreview: fetch 2 glyph via api.glyph, render 2 <path> dgn flip; glyph kedua di-translate(advance1+kern)).
  Update kern hanya geser glyph kedua → instan, tanpa compile_static. set_kerning tetap commit di onMouseUp
  (background). Terverif: slider geser → translate 212→395→95 instan tanpa API.
- KernPreview ikut update saat BENTUK glyph diedit: prop `ver` (=editV) di deps fetch [lname,ver]/[rname,ver].
  App punya `editV` (naik SEGERA tiap commit di onChanged, sebelum bumpFont) → App→SidePanels(prop fontV)→
  KerningPanel→KernPreview. Ringan (2 GET path kecil, hanya saat panel Kern terbuka). Terverif: edit O (LSB) →
  preview re-fetch (translate 570→710, adv 672→742). DELAY ~3s BUKAN dari fitur ini, melainkan dari commit
  set_spacing/set_outline yang MENUNGGU compile_static (~2-3s) sebelum onChanged jalan.
  LEVER PERFORMA UTAMA tersisa: compile_static memblok respons commit → semua edit terasa ~2-3s. Bisa
  di-decouple (save UFO → return cepat, compile di thread background). BELUM dibuat (backend + _write_lock).
- ImportWizard langkah 2 (Bersihkan) — menu ALT & LIGA: komponen AltLigMenu (popover, kiri tombol Ulang)
  dgn 2 textarea (Alternate, Ligature) pisah-koma. State altStr/ligStr. autoFill() parse: parseAlts("Y,a,a")→
  [Y.ss01,a.ss01,a.ss02] (berulang naik .ssNN), parseLigs("RU,ffi")→[R_U,f_f_i]. Disisipkan ke SLOT KOSONG
  tengah autoTokens (idx 141..177 = 37 slot, setelah simbol/diakritik, sebelum 58 multilingual) — alt dulu
  lalu liga, urutan tetap. Terverif: struktur gap 37 slot; parser benar. (altStr/ligStr frontend-state,
  hilang saat reload.)
- _category fix: huruf khusus blok simbol (ı æ œ Æ Œ Ø ø ß = `_PUNCT_LETTERS`) dulu masuk "multilingual"
  (cp≥0xC0 & huruf) → kini "other" (Simbol & tanda baca), sesuai posisinya di _PUNCT_BLOCK. À/É/Š tetap
  multilingual; ×/°/™/ª tetap other. Terverif via _category().
- SpecimenCanvas (langkah 2 import) — 2 fitur:
  (1) Garis baseline/cap bergerak BARENG: onGuideDown default seret garis → SEMUA garis SE-TIPE bergerak
  (ids = filter type===g.type); Shift-klik pilih spesifik → seret = subset itu saja; Alt-seret salin tetap.
  (2) PINDAH glyph: onCanvasDown jika hit shape yg SUDAH terpilih (&&!shift) → dragKind 'moveShapes'
  (marqueeDrag→moveDrag); onMove hitung delta SVG via toSvg(end)-toSvg(start) → setMoveOff (pratinjau live
  via transform translate pada <g> shape terpilih); onUp commit → onMoveShapes→api.stagingMove. PANAH geser
  glyph terpilih (ArrowL/R/U/D, Shift=5×; SVG y-down jadi Up=[0,-1]); nudge=max(1,round(vh*0.004)).
  Backend: staging_move(ids,dx,dy) translasi tiap path (TransformPen (1,0,0,1,dx,dy) + parse_path + SVGPathPen)
  + bbox; TIDAK reorder (urutan baca tetap). Endpoint POST /api/import/staging/move (StageMove{ids,dx,dy}),
  api.stagingMove. Terverif backend: shape geser +50/+30 benar, balik restore, canUndo aktif.
  CATATAN: _staging.json user HILANG (sesi import lama lenyap) → mereka perlu re-import; sementara saya stage
  "Yoruna Full" (141 shape) utk uji.
- SpecimenCanvas lanjutan — 2 fitur:
  (1) PUTUS/SAMBUNG garis: flag `linked` per garis (StagedGuide.linked, default true; backend set_guides
  simpan `linked`, garis lama tanpa key = terhubung). onGuideDown: jika linked!==false → grup se-tipe yang
  TERHUBUNG; jika linked===false → garis itu sendiri. Klik garis tanpa geser → selG={id} (pilih 1). Saat
  selG.size===1 → tombol melayang "Putuskan/Sambungkan" (svgToScreen via getScreenCTM, di atas garis,
  stopPropagation). toggleLink set linked & emitGuides. Label tampil "⊘ lepas" utk garis terputus. emitGuides
  helper kirim {y,type,linked}; addGuide preserve linked. Terverif backend round-trip (lepas 1 → sambung 0).
  (2) Shift saat seret objek → KUNCI SUMBU: onMove moveShapes, jika e.shiftKey → |dx|≥|dy| ? dy=0 : dx=0
  (H/V sesuai arah). Shift dibaca mid-drag (mulai seret tanpa shift, lalu tahan).

PERBAIKAN (sesi lanjutan):
1. Export VF kini 4 format: `.otf` (CFF2 VF) + `.ttf` (glyf VF) + `.woff` + `.woff2`. (CFF2 di-compile
   panggilan fontmake terpisah karena gabungan error `'TTFont' has no attribute lib`; fallback bila gagal.)
2. Penempatan simbol: baseline per-baris kini = median yMax glyph TINGGI saja (`_row_baseline`),
   abaikan simbol kecil melayang (bullet/derajat/kutip) → digit, $€¥£¢, accented duduk benar di baseline.
3. Performa: payload `/project` TIDAK lagi bawa daftar kerning (20k+ pasangan) → ~1MB→41KB, ~0.14s.
   Lookup kerning on-demand `GET /api/kerning?left=&right=`. Edit spacing/kerning → `compile_static`
   (master 0 saja, cepat) bukan rebuild VF penuh; VF dibangun ulang saat axis/master/preset/export.
4. Glyph list dibedakan kategori: uppercase/lowercase/figures/**multilingual**/**alternate**/**ligature**/other
   (`_category` pakai nama glyph + unicodedata). Sel alt/liga render BENTUK ASLI via font live
   (alternate→base+`font-feature-settings "ssNN"`; ligatur→sekuens komponen+`liga`/`dlig`).

PERBAIKAN editor glyph (sesi lanjutan):
- Garis metrik horizontal (atas-bawah): ascender/capHeight/xHeight/baseline/descender + label
  (backend `glyph_svg` kirim capHeight/xHeight). LSB/RSB: bar vertikal, aktif (draggable) hanya di mode Spasi.
- EDITOR NODE (⚠ pergeseran dari PRD D4 "bukan editor outline" — diminta Sensa): toggle mode Spasi/Node.
  Backend `glyph_svg.outline` = kontur terstruktur (titik on/off-curve); `PATCH /api/glyph/{n}/outline`
  → tulis ulang via pointPen → recompile. Frontend `outline.ts` (contoursToPath, addNode de Casteljau,
  removeNode) + GlyphEditor: tampil node (kotak on-curve/lingkaran off-curve) + handle lines, seret
  node/handle (commit saat lepas), tambah (dobel-klik segmen), hapus (pilih + Delete/tombol).
  Preview tetap = final (node→UFO→recompile). Terverifikasi: move/add round-trip, tanpa error.

REVISI BESAR — impor berbasis URUTAN-BACA (ganti per-baris/layout kaku):
Alasan: tiap pengguna menata baris berbeda; yang konsisten = urutan Uppercase→Lowercase→Number
→Punctuation. Alt/Ligature beda tiap font, Multilingual mengikuti. Jadi map per urutan-baca + token.
- `engine/specimen_split.extract_shapes()`: ekstrak SEMUA glyph urut-baca (band baris utk baseline,
  lalu x), **1 path = 1 shape** (multi-bagian di-merge manual). Koordinat em, Y-down, baseline upm*ratio.
- `server/project.py` staging: `stage_import` (preview, belum build), `staging_op` (exclude/include/
  merge/split), `commit_import(tokens)` (token ke-i → shape ke-i; token = char atau nama alt/liga
  `Y.ss01`/`R_U`/`f_i`; tulis per-glyph SVG + `_names.json` → build_ufo). Endpoint /api/import/stage,
  /staging, /staging/op, /commit. Staging resumable.
- `name_and_codepoint`: char tunggal → nama AGL (`0`→zero, `.`→period) agar konsisten preset.
- UI `ImportWizard.tsx` 3 langkah: (1) Upload → preview semua objek bernomor urut-baca;
  (2) Bersihkan → pilih objek, Buang/Pulihkan/Gabung/Pisah; (3) Petakan → tiap shape punya input
  token, tombol Otomatis (isi A–Z a–z 0–9 + punctuation) / Kosongkan (manual) + family/style/preset.
  Terverifikasi end-to-end: stage 236 → clean → map → Import → editor 87 glyph, tanpa error.
- Layout JSON lama (`yoruna-masters` dst.) jadi opsional/legacy; alur utama kini wizard.
- AUTO-FILL token (`_auto_tokens`) mengikuti deret standar Sensatype: A–Z, a–z, 0–9, lalu blok
  `_PUNCT_BLOCK` (¹²³ªº %‰$€¥£¢&*@#| ıæœÆŒØøß™ ,.:;-–—_·•… 8-kutip <>‹›«»/\?!¡¿ ()[]{}©®§+×=°^† diakritik),
  TENGAH kosong (alt/liga manual), dan **58 posisi TERAKHIR = multilingual** (`_MULTILINGUAL`
  29 kapital + 29 minuscule À–Ž/à–ž). Terverifikasi: Yoruna 236→commit 200 glyph (ML 68).
- FIX urutan ekstraksi: deteksi baris AUTO (`_detect_rows`) dulu pakai clustering y-CENTER →
  baris berdekatan dgn tinggi glyph bervariasi (baris diakritik) TERPECAH ke 2 band → diakritik
  ter-interleave dgn punctuation saat sort-x. Diganti: deteksi via STRIP-Y TERISI (interval ink
  overlap = satu baris; toleransi H*0.006). Hasil: 12 baris bersih, punctuation 45 (bukan 49),
  baris mark utuh 7, multilingual tepat di 58 posisi terakhir. Urutan baca benar & monoton.
- FIX template: `^` (caret ASCII U+005E) dihapus dari `_PUNCT_BLOCK` — specimen langsung `°`→`†`
  (circumflex ada di blok diakritik `ˆ`). Tanpa hapus, token geser 1 di posisi 133 (dagger).
- FIX urutan diakritik: SVG = caron, circumflex, … (template saya tertukar circumflex/caron).
  `_PUNCT_BLOCK` diakritik diubah `ˆˇ…`→`ˇˆ¨˜\`´˚¸`. Terverifikasi render: caron/circ/grave/acute/
  dieresis/tilde semua cocok shape↔token. (Import sendiri faithful: outline shape↔glyph 0 mismatch.)

FIX — error compile "unsupported segment type qcurve":
- `skia-pathops.simplify` kadang menghasilkan segmen QUADRATIC; CFF/OTF hanya cubic →
  `compile_static` (single-master, OTF) gagal. (Saat VF/TTF tak terlihat karena glyf dukung quad.)
- Fix: `build_ufo` membungkus pen dgn `Qu2CuPen(all_cubic=True)` → quad→cubic (lossless) saat impor,
  jadi UFO selalu cubic-only. Terverifikasi: import 236 glyph, 0 qcurve, OTF+TTF+WOFF+WOFF2 jadi.

Langkah konkret terdekat:
1. Master Yoruna bobot kedua (mis. Bold) → interpolasi VF nyata. STAT/named-instances. Undo.
   Mark-positioning diakritik (`mark`/`mkmk`).
2. **Fase 4**: bungkus Electron utk distribusi (sidecar Python; code-sign + notarize). Langkah terakhir.

═══════════════════════════════════════════════════════════════════════════════
SESI 2026-06-30 — EDITOR ala FontLab (Tools panel + 5 mode) + loading import + zoom canvas
═══════════════════════════════════════════════════════════════════════════════

Zoom & loading (sebelum mode editor):
- SpecimenCanvas (langkah-2 import) zoom dikonversi dari CSS-transform `scale` (raster di-upscale →
  PECAH) ke VIEWBOX (SVG ukuran tetap, viewBox dipersempit → raster vektor ulang, tajam, "render
  yang terlihat saja") — sama pola GlyphEditor. ⌘/Ctrl+scroll zoom ke kursor, scroll=pan.
- Loading import: backend `commit_import` lapor progres (build_ufo dapat callback `progress(frac,label)`
  per-glyph — tahap terberat); `self._progress` dibaca via `GET /api/import/progress` (tanpa lock →
  poll mulus selagi commit pegang write-lock). Frontend ImportWizard poll 300ms → overlay bar %.
  Peta: siapkan 2% → normalisasi 2–14% → build_ufo 15–80% → compile preview 82% → 100%.

EDITOR — Tools panel kiri (vertikal) + 5 mode (`app/src/components/GlyphEditor.tsx`), Mode type =
`"contour"|"element"|"metrics"|"kerning"|"text"`. Tiap mode di-audit-sendiri setelah dibuat.
- **Contour** (eks "node"): edit node/handle + sub-alat (Pilih/Kotak/Elips/Anchor di panel Tools).
  - Draw shapes: `makeRect` (4 line), `makeEllipse` (kappa, 4 curve+8 off). Node/handle diperbesar
    (nodeR 0.0112) + area klik transparan 2.1×.
  - Multi-select node: `sel:Set<string>` ("ci:pi"), marquee + Shift-klik, group-move (`nodeGroup`),
    arrow-nudge, multi-delete. Transform cluster (flip H/V, rotate, scale via `transformSel`).
  - **Anchors** (BACKEND): `glyph_svg`→`anchors:[{name,x,y}]`; `set_anchors` (locked, NO recompile);
    `PUT /api/glyph/<n>/anchors`. UI: sub-alat Anchor (klik=tambah), penanda amber + label tegak,
    seret/rename/hapus.
  - **Components** (BACKEND): `glyph_svg` path kini KONTUR-saja via `_contour_path` (SVGPathPen CRASH
    pada glyph berkomponen + path harus exclude komponen); `components:[{base,transform[6],basePath,
    baseBounds}]`; `set_components` (locked, recompile); `PUT .../components`. UI: tambah via datalist,
    render biru, seret/skala/hapus. Verified fontmake mengompilasi komponen.
- **Element**: elemen = kontur "c{i}"/komponen "m{i}". Affine helpers `aApply/aCompose/aFlip/aRot/aScale`
  (diuji terisolasi). Klik/marquee/Shift pilih elemen utuh, drag-move, transform (compose matriks utk
  komponen), delete, duplicate (⌘D), group/ungroup (⌘G, **sesi-lokal** belum ke UFO). Fill kontur tetap
  benar (lubang) via path gabungan; hit-layer transparan per-kontur + komponen di atas.
- **Metrics** (eks "space"): advance kini BISA diedit (`commitAdvance`→`commitSpace(lsb, v-glyphW-lsb)`,
  cocok `set_spacing`). `MetricsStrip` (ref·glif·glif·ref) update live LSB/RSB; glyph pakai
  `glyphXMin=bbox0.xMin` (kontur tak ditranslasi saat spasi). Tanpa kerning (murni sidebearing).
- **Kerning**: `KerningCanvas` ganti kanvas → pasangan [kiri][kanan], seret glyph kanan = atur kern
  (getScreenCTM/m.a), commit `serial(setKerning)`+refresh preview. viewBox TETAP (skala konstan saat
  drag → 1:1). Partner via datalist, toggle sisi, field Kern. Backend kern = pair sederhana.
- **Text**: `TextProof` ganti kanvas → render string (cmap via `charToName` prop dari App) sbg deret
  glyph, advance+kern, multi-baris, notdef box. Cache di ref `glyphCache`/`kernCache` (debounce 250ms,
  cleared saat masuk text), `proofTick` paksa re-render. Bottom bar: textarea + slider ukuran + toggle
  Kerning. CATATAN: "Sketchboard text frames" SENGAJA tak dibuat (di luar lingkup kanvas tunggal).

Robustness ditambah sesi ini:
- **Undo komponen**: `Snap.components?` + `pushHist` auto-inject + `commitComps` push + `applySnap`
  restore (skip recompile bila sama).
- **Antrean commit `serial()`**: SEMUA tulis (Outline/Spacing/Metric/Anchors/Components/applySnap) lewat
  promise-chain FIFO → tak balapan saat operasi beruntun. (Diuji FIFO terisolasi.)

Cara verifikasi (saya TAK bisa drive browser; preview/Chrome MCP gagal konek): tsc --noEmit + vite build
tiap langkah; backend uji round-trip di SCRATCH UFO (workspace TAK tersentuh — hindari uji destruktif
pada glyph asli, lihat memori); cek payload live read-only; matematika affine/advance/kerning diuji node.

Bug yang ditangkap saat audit-sendiri (per langkah): bbox0 vs d.lsb (Metrics strip), prop `ref` reserved
React, z-order komponen Element, viewBox kern-dependent (drag licin), byte NUL di key cache kern (file
jadi "binary"), Tools dock menutupi awal teks proof.

Belum dikerjakan (opsional, butuh konfirmasi): grup Element persisten ke UFO (glyph.lib, indeks-basi);
undo untuk anchors; Sketchboard/text frames; local guides per-glyph.

LANJUTAN — Kerning level-kelas + Text instan:
- TEMUAN: kerning font = level GROUP/KELAS (`public.kern1.X`·`public.kern2.Y`), bukan pasangan glyph.
  Editor Kerning lama pakai get/set pasangan-glyph → A·V tampil 0 (kern asli di group). Group hasil
  impor mayoritas singleton (`kern1.A=[A]`), sebagian berbagi (`kern2.V=[V,W]`).
- Kerning kini LEVEL-KELAS: `_kern_groups`, `get_kern` resolusi §9.6 (pair>grpL,R>L,grpR>grpL,grpR) +
  return {value,leftGroup,rightGroup,classValue,pairValue}; `set_kerning(scope)` tulis grup (default
  'class') / glyph ('pair'). UI: toggle Kelas/Pasangan + info grup. KernPreview SidePanels ikut benar.
- PERLUAS KELAS (pilihan user): `expand_kern_groups` — dekomposisi NFD → huruf dasar; gabungkan varian
  aksen ke kelas dasar (kern1/kern2); rekey kerning (DASAR menang). `POST /api/kerning/expand-groups`,
  tombol "Perluas kelas". Diuji di salinan scratch (font asli tak tersentuh): 58 varian, A-V/Aacute-V/
  Acircumflex-V semua −150. User memicu via tombol (operasi mengubah groups+kerning).
- TEXT INSTAN: dulu debounce 250ms fetch per-huruf (lambat muncul). Kini `GET /api/glyphs/render`
  (`glyphs_render`) kirim SEMUA glyph {path,advance,components} dalam 1 panggilan (271KB/0.17s) →
  dimuat sekali saat masuk mode Text → ketik langsung tampil dari cache. Kern menyusul (debounce 120ms).
- SINKRON 2 editor kerning (mode Kerning ↔ tab "Kern" panel kanan): keduanya refetch saat ada commit
  via versi `fontV`/`editV`. Panel kanan diubah pakai NAMA GLYPH + resolusi backend (bukan map group
  sisi-klien yang basi setelah Perluas kelas). Slider panel −400..400.
- SNAP KE NODE/HANDLE: dulu grid-only (`snap1`). Tambah ALIGNMENT snap ke X/Y node-handle lain +
  garis metrik (baseline/xH/cap/asc/desc). Toggle terpisah `snapNodes` (ikon Crosshair, default ON)
  di samping magnet grid. `snapNode(rawX,rawY,exclCi,exclSet)`: dalam 6px (`6*upp()`) dari target →
  align (prioritas), grid sbg fallback per-sumbu. Kecualikan node + handle-nya (biar tak snap ke diri).
  Dipakai di drag node on-curve / handle / anchor (bukan group/element). Garis bantu magenta saat seret.
- TRACKING GLOBAL (#1, atas permintaan "atur keseluruhan"): spasi seragam berlapis di atas kerning,
  NON-DESTRUKTIF. `tracking` di meta + state; `set_tracking` (PUT /api/tracking, tak recompile);
  export `_tracked_ufo` bake `width+=tracking` ke salinan UFO (asli utuh; static + master VF). Live di
  preview tanpa recompile: PreviewBar CSS letterSpacing; TextProof/KerningCanvas/KernPreview tambah ke
  advance/gap. Field "Tracking" di bar Kerning. Diuji: advance +30 (asli tetap), endpoint round-trip.
