#!/bin/bash
# Publikasikan UPDATE ISI (tanpa installer baru): build UI → rakit content → zip →
# unggah ke GitHub release tag "content" (clobber). Aplikasi terpasang (≥ minApp) menariknya
# otomatis dan menerapkannya saat dibuka berikutnya. Untuk perubahan UI/engine/server saja.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
REPO="sensatype/Sensatype-Font-Tool-App"

echo "→ Build UI…"; (cd app && npm run build >/dev/null)
echo "→ Rakit content…"; bash scripts/build-content.sh
CVER=$(node -p "require('./content/meta.json').content")
MINAPP=$(node -p "require('./content/meta.json').minApp")

echo "→ Zip…"; rm -f content.zip; (cd content && zip -qr ../content.zip .)
URL="https://github.com/$REPO/releases/download/content/content.zip"
printf '{"content":%s,"minApp":"%s","url":"%s"}\n' "$CVER" "$MINAPP" "$URL" > content.json

echo "→ Unggah ke release 'content'…"
gh release view content -R "$REPO" >/dev/null 2>&1 || \
  gh release create content -R "$REPO" --prerelease --title "Content channel" \
    --notes "Saluran update isi (UI+engine+backend) — ditarik otomatis oleh aplikasi. Bukan installer."
gh release upload content -R "$REPO" content.zip content.json --clobber
rm -f content.zip content.json
echo "✓ Content v$CVER terpublikasi (minApp $MINAPP). Aplikasi ≥ $MINAPP akan menariknya."
