# PRD — Sensatype Font Tool (nama kerja)

> Product Requirements Document. Gambaran proyek secara keseluruhan.
> Dokumen acuan tunggal untuk semua sesi pengembangan (termasuk Claude Code).

---

## 1. Ringkasan

Aplikasi internal untuk menyatukan seluruh alur produksi font Sensatype ke dalam **satu pipeline**, menghapus ketergantungan pada alat pihak ketiga (Fontself + FontLab) dan menghilangkan pekerjaan ganda.

**Input:** glyph berbentuk SVG yang sudah didesain di aplikasi vector (Illustrator/Figma).
**Output:** OTF, TTF, WOFF, WOFF2 — plus metadata font lengkap dan dukungan variable font/family.

---

## 2. Masalah yang dipecahkan

Saat ini Sensatype bekerja **dua kali** dengan dua aplikasi terpisah:

1. **Fontself** — mengubah shape vector menjadi glyph → OTF.
2. **FontLab** — mengonversi OTF → TTF/WOFF/WOFF2 dan mengisi metadata.

Pekerjaan ganda ini terjadi karena ada **file OTF yang dioper antar dua aplikasi**. Selain merepotkan, ini membuat Sensatype bergantung pada lisensi & roadmap pihak lain — bertentangan dengan tujuan kemandirian.

---

## 3. Tujuan & non-tujuan

### Tujuan
- Satu aplikasi: SVG → 4 format font, end-to-end, tanpa file perantara keluar dari app.
- Kemandirian penuh: format terbuka, tanpa lock-in proprietary, tanpa dependensi pihak ketiga.
- Drag-and-drop SVG → glyph (terinspirasi Fontself Maker).
- Form metadata font (name table OpenType).
- Auto + manual spacing/kerning.
- Dukungan variable font / family (multi-master).

### Non-tujuan (eksplisit TIDAK dibangun)
- **Bukan editor outline.** Tidak ada tool pen/knife/edit node. Desain glyph terjadi di aplikasi vector (upstream), bukan di app ini. Ini melompati ~60% kerumitan FontLab secara sengaja.
- **Bukan klon FontLab.** Yang diambil dari FontLab hanya: glyph grid, panel masters, slider axis.
- Tidak mengejar paritas auto-kerning kelas iKern (lihat §8 Fase 2).

---

## 4. Pengguna

- **Sensa** — operator utama, mendesain & memproduksi font.
- **Senior draft font** — pengguna kedua; menerima hasil akhir lewat app terbungkus (Electron).

Alur kerja dominan: memproduksi family satu per satu (mis. Yoruna Didone), bukan batch massal.

---

## 5. Arsitektur inti

### Prinsip
**SVG → UFO → fontmake → OTF/TTF/WOFF/WOFF2.**

UFO bukan sekadar format perantara — UFO adalah **format project / satu sumber kebenaran**. "Save project" = tulis UFO. "Export" = fontmake mengompilasi UFO. File OTF yang dulu dioper antar app **tidak ada lagi**.

Keuntungan UFO:
- Format terbuka (mendukung tujuan kemandirian).
- Memisahkan "gambar glyph" dari "kompilasi binary".
- Skalabel ke variable font lewat designspace + multi-master UFO (jalur langsung dari workflow interpolasi Yoruna).
- Menyimpan glyph, advance width (`.glif`), kerning (`kerning.plist`), dan class kerning (`groups.plist`) dalam satu standar.

### Pembagian runtime (berdasarkan lokasi risiko)

| Layer | Runtime | Risiko | Tugas |
|---|---|---|---|
| **Impor** | Python (sidecar) | TINGGI | Parse SVG → bersihkan geometri (Y-flip, winding, overlap) → tulis UFO. *Menggantikan Fontself.* |
| **Format project** | UFO + designspace | — | Satu sumber kebenaran. Glyph, metrics, kerning, masters. |
| **Auto-assist** | Python (algoritmik) | RENDAH | Preset manual → HT Letterspacer (spacing) → seed kerning Tier-1 (distance-based, class-level). |
| **Edit** | Electron / JS | RENDAH | Glyph grid, drag-drop assignment, live preview, kontrol manual spacing/kerning, form metadata, panel masters/axis. |
| **Ekspor** | Python (sidecar) | TINGGI | fontmake + fontTools → OTF/TTF/WOFF/WOFF2. *Menggantikan FontLab.* |

> Catatan penting: seluruh **risiko nyata** ada di kotak Python (impor & ekspor). Layer Electron adalah UI standar.

---

## 6. Stack teknologi

**Python (engine)**
- `fontTools` — manipulasi font, WOFF/WOFF2.
- `fontmake` — kompilasi UFO/designspace → OTF/TTF (termasuk cu2qu untuk TTF & pembalikan arah kontur).
- `ufoLib2` — baca/tulis UFO.
- `picosvg` — normalisasi SVG (resolve transform, absolute path).
- `skia-pathops` — union kontur (memperbaiki winding + membuang overlap dalam satu langkah).
- **HT Letterspacer** — auto-spacing algoritmik (open-source, native UFO).

**Frontend**
- React + Vite (dikembangkan & dites di **browser**).
- API lokal: Flask/FastAPI (jembatan ke engine Python).
- **Electron** — HANYA pembungkus distribusi di langkah terakhir.

**Mesin**
- Pengembangan & test: **MacBook Air M1** (venv lokal).
- **JANGAN** di Mac Mini M4 (server produksi tidak boleh terganggu).

---

## 7. Scope v1

Pipeline dan fitur yang masuk rilis pertama:

- [x] Pipeline impor → UFO → ekspor (4 format).
- [x] Drag-drop SVG → assign ke glyph (skema penamaan/Unicode: A-Z / a-z / 0-9 / batch).
- [x] Form metadata font (family, style, designer, URL, lisensi, copyright, trademark, demo text).
- [x] Spacing: auto seed (HT Letterspacer) + manual (drag handle + input angka).
- [x] Kerning: auto seed (Tier-1 distance-based) + manual (slider + input angka), **level kelas**.
- [x] Variable font / family (UFO + designspace, panel masters + slider axis).
- [x] **Editor glyph ala FontLab** — panel Tools (kiri) + 5 mode: **Contour** (edit node/handle, gambar
  kotak/elips, multi-select + transform flip/rotate/scale, anchors, components), **Element** (pindah/
  transform/group elemen utuh), **Metrics** (advance + sidebearing, strip konteks live), **Kerning**
  (pasangan glyph, seret = atur kern), **Text** (ketik/tempel teks → proofing deret glyph). Zoom kanvas
  berbasis viewBox (tajam, "render yang terlihat saja"). Undo/redo per-glyph + antrean commit serial.
  *(Catatan: "Sketchboard / text frames" multi-frame ala FontLab = di luar scope v1.)*

**Target sweet spot v1:** serif & sans, display & text (tempat auto-assist paling kuat; Yoruna ada di sini).

**Handwriting di v1:** *bisa diekspor* lewat pipeline universal, tetapi spacing/kerning-nya **manual** (auto-assist lemah untuk kategori ini — by design).

---

## 8. Fase 2 (ditunda, jangan dibangun di v1)

Menambahkan ini ke v1 = risiko proyek mangkrak.

- **Editor kode `.fea`** (OpenType features mentah). Di v1, feature di-generate otomatis (`kern` dari data kerning, `liga` dari daftar ligatur). IDE feature manual = fase 2.
- **Handwriting authoring**: alternates (init/medial/final/isolated), ligature, `calt` + logika pseudo-random. Workstream tersendiri.
- **Gemma auto-classification**: pemilihan preset otomatis untuk **batch besar** (mis. memproses ulang katalog 3.800 font). ROI-nya muncul di skenario bulk, bukan produksi satu-per-satu. Sambungannya sudah disiapkan (drop-in di slot "preset").
- **Kerning Tier-2 (optical, kelas iKern)**: TIDAK direkomendasikan. Matematikanya bukan yang mahal — tuning visualnya yang mahal (itu sebabnya iKern berbayar). Tier-1 seed + finishing manual lebih cepat secara total untuk kebutuhan internal.

---

## 9. Aturan korektness (NON-NEGOTIABLE)

Pelanggaran aturan ini menghasilkan kegagalan diam-diam (silent corruption) yang mahal di-debug.

1. **Bersihkan geometri SEKALI saat impor** (Y-flip, winding, overlap). Auto-assist mengukur dan preview merender **outline yang sudah dibersihkan** — tidak pernah SVG mentah. Jika tidak: auto-spacing salah ukur DAN preview ≠ font final.
2. **Winding/coordinate**: SVG = Y-down + sering evenodd. Font = Y-up + nonzero winding. Compound path (counter di o/a/e) adalah zona bahaya — winding salah = counter jadi **hitam solid**.
3. **Gunakan skia-pathops union** untuk menggabung kontur: sekaligus memperbaiki winding DAN membuang overlap (output union selalu nonzero winding yang benar). "Bersihkan geometri" sebagian besar adalah satu operasi ini.
4. **Kontrol manual = translasi posisi saja**, tidak pernah menderivasi ulang bentuk di JS. Preview = final.
5. **Nilai UI dalam unit em**, konsisten dengan UPM (mis. -40 pada UPM 1000), bukan piksel layar.
6. **Kerning ditulis ke level KELAS** (`groups.plist`), bukan raw pair. Raw pair = jurang n² yang bikin mangkrak.
7. **Kerning group wajib kompatibel di semua master.** Group/pair yang beda antar-master = interpolasi pecah. Kerning didefinisikan family-level, dipakai bersama.

---

## 10. Urutan build (de-risk dulu)

Validasi dari bagian paling berisiko ke paling tidak berisiko. **Jangan bangun UI sebelum engine terbukti.**

1. **Engine smoke test** (Python CLI murni, headless) — beberapa SVG → 4 format. **Make-or-break.**
2. **Glyph asli + spacing** — tambah HT Letterspacer, verifikasi seed masuk akal. Masih skrip kecil.
3. **UI** — React/Vite di **browser**, ngobrol ke API Python lokal. (Bukan di Electron.)
4. **Electron** — bungkus paling akhir untuk distribusi ke senior draft.

> Electron adalah pembungkus distribusi, **bukan** lingkungan dev/test. Bahkan saat UI dibangun, test dilakukan di browser (Vite + API lokal) — pola yang sama seperti stack Mac Mini (Vite + backend + PM2).

---

## 11. Kriteria sukses (smoke test, Fase 1)

Smoke test dianggap lolos bila, setelah ekspor dan install font:

- [ ] Counter pada **"o" / "e"** berlubang — **bukan hitam solid** (uji winding).
- [ ] Huruf duduk rapi di **baseline**, tinggi konsisten (uji Y-flip + pemetaan UPM).
- [ ] **Keempat format** (OTF/TTF/WOFF/WOFF2) terbuka & merender.
- [ ] Satu glyph **Yoruna asli** lolos sebagai test edge case.

Mulai dari 3–4 huruf sederhana (H, O, n, e) supaya jika pecah, jelas itu engine — bukan kerumitan SVG Yoruna. Smoke test **sengaja tidak** menguji drag-drop maupun slider (itu risiko rendah; yang dibuktikan dulu adalah engine).

---

## 12. Batasan & risiko

- **Server produksi (Mac Mini M4) tidak boleh terganggu** → semua dev di MacBook Air M1.
- **Packaging Electron**: code-signing + notarization untuk macOS **dan** Windows (sidecar Python), ukuran app +50–100MB. Masuk rencana sejak awal, dieksekusi di langkah terakhir.
- **Handwriting**: penting secara komersial (keyword peluang tinggi), tetapi auto-engine-nya sengaja lemah di v1. Produksi handwriting tetap bisa; finishing-nya manual.
