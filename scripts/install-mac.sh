#!/bin/bash
# Pemasang Sensatype Font Tool untuk macOS (Apple Silicon).
# Unduh rilis TERBARU dari GitHub, pasang ke /Applications (atau ~/Applications bila tak ada
# izin), lalu hapus atribut karantina Gatekeeper -> tanpa "damaged"/"Open Anyway".
#
# Cara pakai (unduh dulu ke file lalu jalankan -- paling aman utk bash lama macOS):
#   curl -fsSL https://raw.githubusercontent.com/sensatype/Sensatype-Font-Tool-App/main/scripts/install-mac.sh -o /tmp/sti.sh && bash /tmp/sti.sh
# (Boleh juga: curl -fsSL ... | bash)
set -eo pipefail   # sengaja TANPA -u: hindari 'unbound variable' pada bash 3.2 macOS

REPO="sensatype/Sensatype-Font-Tool-App"
API="https://api.github.com/repos/${REPO}/releases/latest"
MNT=""; TMP=""
cleanup() { [ -n "${MNT}" ] && hdiutil detach "${MNT}" >/dev/null 2>&1; [ -n "${TMP}" ] && rm -rf "${TMP}"; return 0; }
trap cleanup EXIT

ARCH="$(uname -m)"
if [ "${ARCH}" != "arm64" ]; then
  echo "[x] Skrip ini untuk Mac Apple Silicon (arm64). Mac Anda: ${ARCH}." >&2
  exit 1
fi

echo "-> Mencari rilis terbaru..."
URL="$(curl -fsSL "${API}" | grep -oE 'https://[^"]*arm64\.dmg' | head -1 || true)"
if [ -z "${URL}" ]; then
  echo "[x] Tidak menemukan installer .dmg (arm64) di rilis terbaru." >&2
  exit 1
fi
VER="$(printf '%s' "${URL}" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
echo "-> Versi ${VER}"

# Tujuan pasang: /Applications bila bisa ditulis, jika tidak ~/Applications (tanpa sudo).
DEST="/Applications"
if [ ! -w "${DEST}" ]; then DEST="${HOME}/Applications"; fi
mkdir -p "${DEST}"
APP="${DEST}/Sensatype Font Tool.app"

TMP="$(mktemp -d)"
DMG="${TMP}/sensatype.dmg"
echo "-> Mengunduh..."
curl -fL --progress-bar "${URL}" -o "${DMG}"

echo "-> Memasang ke ${DEST} ..."
MNT="${TMP}/mnt"; mkdir -p "${MNT}"
hdiutil attach "${DMG}" -nobrowse -noverify -mountpoint "${MNT}" >/dev/null
SRC="$(ls -d "${MNT}"/*.app 2>/dev/null | head -1 || true)"
if [ -z "${SRC}" ]; then echo "[x] Berkas .app tak ditemukan dalam dmg." >&2; exit 1; fi
rm -rf "${APP}"
ditto "${SRC}" "${APP}"
hdiutil detach "${MNT}" >/dev/null 2>&1 || true; MNT=""
xattr -dr com.apple.quarantine "${APP}" >/dev/null 2>&1 || true

echo "[OK] Terpasang: ${APP}"
echo "-> Membuka aplikasi..."
open "${APP}"
