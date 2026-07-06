#!/bin/bash
# Pemasang Sensatype Font Tool untuk macOS (Apple Silicon).
# Mengunduh rilis TERBARU dari GitHub, memasang ke /Applications (atau ~/Applications bila
# tak ada izin), lalu menghapus atribut karantina Gatekeeper — jadi TANPA "Open Anyway".
#
# Jalankan satu baris:
#   curl -fsSL https://raw.githubusercontent.com/sensatype/Sensatype-Font-Tool-App/main/scripts/install-mac.sh | bash
set -euo pipefail

REPO="sensatype/Sensatype-Font-Tool-App"
API="https://api.github.com/repos/$REPO/releases/latest"
MNT=""
trap '[ -n "$MNT" ] && hdiutil detach "$MNT" >/dev/null 2>&1 || true; [ -n "${TMP:-}" ] && rm -rf "$TMP"' EXIT

if [ "$(uname -m)" != "arm64" ]; then
  echo "✗ Skrip ini untuk Mac Apple Silicon (arm64). Mac Anda: $(uname -m)." >&2
  exit 1
fi

echo "→ Mencari rilis terbaru…"
# `|| true`: dengan set -e, grep tanpa hasil akan mematikan skrip SEBELUM pesan error ramah di bawah
URL=$(curl -fsSL "$API" | grep -oE 'https://[^"]*arm64\.dmg' | head -1 || true)
if [ -z "${URL:-}" ]; then
  echo "✗ Tidak menemukan installer .dmg (arm64) di rilis terbaru." >&2
  exit 1
fi
VER=$(printf '%s' "$URL" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
echo "→ Versi ${VER:-?}"

# Tujuan pasang: /Applications bila bisa ditulis, jika tidak ~/Applications (tanpa sudo).
DEST="/Applications"
if [ ! -w "$DEST" ]; then DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
APP="$DEST/Sensatype Font Tool.app"

TMP=$(mktemp -d)
DMG="$TMP/sensatype.dmg"
echo "→ Mengunduh…"
curl -fL# "$URL" -o "$DMG"

echo "→ Memasang ke $DEST…"
MNT="$TMP/mnt"; mkdir -p "$MNT"
hdiutil attach "$DMG" -nobrowse -noverify -mountpoint "$MNT" >/dev/null
SRC=$(ls -d "$MNT"/*.app 2>/dev/null | head -1)
[ -n "$SRC" ] || { echo "✗ Berkas .app tak ditemukan dalam dmg." >&2; exit 1; }
rm -rf "$APP"
ditto "$SRC" "$APP"
hdiutil detach "$MNT" >/dev/null 2>&1 || true; MNT=""
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "✓ Terpasang: $APP"
echo "→ Membuka aplikasi…"
open "$APP"
