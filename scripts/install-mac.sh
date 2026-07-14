#!/bin/bash
# Pemasang Sensatype Font Tool untuk macOS (Apple Silicon) -- BERSIH & anti-gagal.
# Keluarkan app lama, hapus dari /Applications & ~/Applications, bersihkan sisa isi lama,
# unduh rilis TERBARU, pasang ke /Applications (fallback ~/Applications), hapus karantina.
#
#   curl -fsSL "https://raw.githubusercontent.com/sensatype/Sensatype-Font-Tool-App/main/scripts/install-mac.sh?v=$(date +%s)" -o /tmp/sti.sh && bash /tmp/sti.sh
set -eo pipefail   # TANPA -u (hindari 'unbound variable' pada bash 3.2 macOS)

REPO="sensatype/Sensatype-Font-Tool-App"
API="https://api.github.com/repos/${REPO}/releases/latest"
NAME="Sensatype Font Tool"
MNT=""; TMP=""
cleanup() { [ -n "${MNT}" ] && hdiutil detach "${MNT}" >/dev/null 2>&1; [ -n "${TMP}" ] && rm -rf "${TMP}"; return 0; }
trap cleanup EXIT

if [ "$(uname -m)" != "arm64" ]; then
  echo "[x] Skrip ini untuk Mac Apple Silicon (arm64). Mac Anda: $(uname -m)." >&2; exit 1
fi

echo "-> Menutup aplikasi lama (bila terbuka)..."
osascript -e "quit app \"${NAME}\"" >/dev/null 2>&1 || true
sleep 1
pkill -f "${NAME}.app" >/dev/null 2>&1 || true; sleep 1

echo "-> Menghapus versi lama (kedua lokasi) + sisa isi lama..."
rm -rf "/Applications/${NAME}.app" "${HOME}/Applications/${NAME}.app"
# sisa "isi" (content overlay/staging) dari update lama -> agar baseline v-baru dipakai bersih.
# TIDAK menyentuh project Anda (itu di folder 'projects', tak dihapus).
SUP="${HOME}/Library/Application Support/${NAME}"
rm -rf "${SUP}/content" "${SUP}/content-staging"

echo "-> Mencari rilis terbaru..."
URL="$(curl -fsSL "${API}" | grep -oE 'https://[^"]*arm64\.dmg' | head -1 || true)"
if [ -z "${URL}" ]; then echo "[x] Installer .dmg (arm64) tak ditemukan." >&2; exit 1; fi
VER="$(printf '%s' "${URL}" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
echo "-> Versi ${VER}"

DEST="/Applications"; [ -w "${DEST}" ] || DEST="${HOME}/Applications"; mkdir -p "${DEST}"
APP="${DEST}/${NAME}.app"

TMP="$(mktemp -d)"; DMG="${TMP}/app.dmg"
echo "-> Mengunduh..."
curl -fL --progress-bar "${URL}" -o "${DMG}"

echo "-> Memasang ke ${DEST} ..."
MNT="${TMP}/mnt"; mkdir -p "${MNT}"
hdiutil attach "${DMG}" -nobrowse -noverify -mountpoint "${MNT}" >/dev/null
SRC="$(ls -d "${MNT}"/*.app 2>/dev/null | head -1 || true)"
if [ -z "${SRC}" ]; then echo "[x] .app tak ada dalam dmg." >&2; exit 1; fi
ditto "${SRC}" "${APP}"
hdiutil detach "${MNT}" >/dev/null 2>&1 || true; MNT=""
xattr -dr com.apple.quarantine "${APP}" >/dev/null 2>&1 || true

INST="$(defaults read "${APP}/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?')"
echo "[OK] Terpasang v${INST} di: ${APP}"
echo "-> Membuka aplikasi..."
open "${APP}"
