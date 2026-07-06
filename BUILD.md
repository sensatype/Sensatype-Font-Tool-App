# Build & Distribusi — Sensatype Font Tool

Aplikasi = Electron (shell) + backend Python (FastAPI/uvicorn) + UI React.

## Autentikasi (login) → Mac Mini M4

- Aplikasi selalu menembak **domain publik** `https://project.sensatype.com` untuk login.
  Arahkan domain itu ke **Mac Mini M4** (DNS + reverse-proxy/TLS). Jangan ke MacBook.
- Di build Electron, alamat ini di-set eksplisit di `app/electron/main.cjs`
  (`AUTH_API_BASE` / `AUTH_LOGIN_URL`) sehingga aplikasi terpasang tak pernah ikut
  variabel env lokal MacBook. Override hanya untuk uji (`SENSATYPE_API_BASE`).
- `SENSATYPE_REDIRECT_URI = http://127.0.0.1:8000/api/auth/callback` HARUS ada di
  allowlist redirect_uri server Sensatype (Mac Mini M4).

## Update di dalam aplikasi (GitHub Releases)

- Sumber: `build.publish` di `app/package.json` (`owner`/`repo`) — dan konstanta
  `REPO` di `app/electron/updater.cjs`. **Ganti placeholder `sensatype/font-tool`
  dengan repo GitHub sebenarnya** (repo rilis sebaiknya PUBLIC agar GitHub API
  bisa diakses tanpa token).
- **Windows (NSIS):** auto-update penuh — unduh di latar → "Pasang & mulai ulang".
  Jalan tanpa code-signing.
- **macOS:** Squirrel.Mac wajib app ber-signature Developer ID untuk auto-install.
  Build ini tanpa signing → aplikasi hanya **cek versi + beri tahu + buka halaman
  rilis** untuk unduh `.dmg` manual. (Kalau nanti mau auto-install penuh di mac,
  perlu sertifikat Apple Developer + notarization.)
- Menu **Bantuan → Periksa Pembaruan…** memicu cek manual; ada juga auto-cek ~4 dtk
  setelah aplikasi terbuka.
- **Naikkan `version` di `app/package.json` setiap rilis** — updater membandingkan
  versi ini dengan tag rilis GitHub (`vX.Y.Z`).

## Langkah build installer

### Prasyarat (tiap kali backend berubah): bekukan backend Python

electron-builder menyalin `../backend-dist/sensatype-backend` → `resources/backend/`,
plus `engine/` → `resources/engine/` dan `app/dist` → `resources/dist/` sebagai FILE
NYATA (lihat `extraResources`). Backend dibekukan via `backend.spec`:

```bash
# di root repo, dalam .venv MacBook (BUKAN Mac Mini server)
pip install pyinstaller
pyinstaller --noconfirm --distpath backend-dist --workpath build/pyi backend.spec
# validasi bundle (fontmake/PyMuPDF/skia-pathops):
./backend-dist/sensatype-backend/sensatype-backend --selftest
```

engine/ SENGAJA tidak dibekukan ke dalam bundle (dikirim sbg file nyata) supaya
resolusi `__file__` modul engine + data JSON-nya tetap benar. Server menemukannya
lewat env `SENSATYPE_ENGINE_DIR`/`SENSATYPE_DIST_DIR` yang di-set `main.cjs` di mode
terpasang. PyInstaller TIDAK cross-compile — .exe Windows harus dibekukan di Windows.

### macOS (.dmg) — di MacBook (TERUJI)

```bash
cd app && npm run dist:mac      # hasil di app/release/*.dmg (arm64)
```

### Windows (.exe) — otomatis via GitHub Actions

PyInstaller tak bisa cross-compile dari Mac, jadi `.exe` dibangun di CI
(`.github/workflows/build.yml`, runner `windows-latest`).

### Rilis (mac .dmg + win .exe sekaligus, untuk auto-update)

1. Naikkan `version` di `app/package.json` (mis. `0.2.0`).
2. Tag & push:
   ```bash
   git commit -am "rilis v0.2.0" && git tag v0.2.0 && git push origin main v0.2.0
   ```
3. Workflow membangun **macOS (.dmg)** + **Windows (.exe + latest.yml)** dan
   mengunggahnya ke **draft release** bernama versi itu.
4. Buka tab Releases → **publish** draft-nya. Setelah publish, auto-update Windows
   aktif; macOS melihat versi baru & menawarkan unduh `.dmg`.

> Uji build tanpa publish: jalankan workflow manual (tab Actions → Run workflow).

## Nama & ikon

- Nama tampil: `build.productName` = "Sensatype Font Tool" (ubah di `package.json`).
- Ikon: taruh `app/build/icon.png` (1024×1024) — electron-builder otomatis membuat
  `.icns`/`.ico`. Tanpa file ini, ikon Electron default dipakai.
