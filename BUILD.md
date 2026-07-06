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

### Prasyarat (SEKALI, dan tiap kali backend berubah): bekukan backend Python

electron-builder menyalin `../backend-dist` → `resources/backend/` (lihat
`extraResources`). Folder itu dihasilkan PyInstaller:

```bash
# di root repo, dalam .venv MacBook (BUKAN Mac Mini server)
pip install pyinstaller
pyinstaller --noconfirm --clean \
  --name sensatype-backend \
  --collect-all fontmake --collect-all fontTools --collect-all ufoLib2 \
  --collect-all picosvg --collect-all fontMath --collect-all booleanOperations \
  --collect-all cu2qu --collect-all glyphsLib --collect-all fitz --collect-all uvicorn \
  --collect-submodules keyring \
  --add-data "engine:engine" \
  --paths engine \
  --distpath backend-dist \
  server/_run.py
```

Sesuaikan `--collect-all/--add-data` bila ada modul/data yang belum terbawa
(uji `backend-dist/sensatype-backend/sensatype-backend --port 8000` lalu buka
`/api/health`). Catatan: PyInstaller TIDAK cross-compile — .exe Windows harus
dibekukan di mesin/CI Windows.

### macOS (.dmg) — di MacBook

```bash
cd app && npm run dist:mac      # hasil di app/release/*.dmg
```

### Windows (.exe) — di mesin/CI Windows

Freeze backend di Windows (langkah di atas, `--distpath backend-dist`), lalu:

```bash
cd app && npm run dist:win      # hasil di app/release/*.exe (NSIS)
```

### Publish rilis (untuk update otomatis)

```bash
cd app && GH_TOKEN=<token> npm run release   # build + unggah ke GitHub Releases
```

## Nama & ikon

- Nama tampil: `build.productName` = "Sensatype Font Tool" (ubah di `package.json`).
- Ikon: taruh `app/build/icon.png` (1024×1024) — electron-builder otomatis membuat
  `.icns`/`.ico`. Tanpa file ini, ikon Electron default dipakai.
