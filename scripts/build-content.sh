#!/bin/bash
# Rakit folder "isi" (content) = kode aplikasi yang BISA di-update tanpa reinstall:
#   server/  engine/  dist/  meta.json
# Dipakai saat build installer (baseline) DAN saat publish content update.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# minApp = installer TERTUA yang library/cangkangnya kompatibel dgn isi ini. Naikkan HANYA
# saat isi mulai butuh library Python baru / fitur cangkang baru (jarang).
MIN_APP="0.1.18"

OUT="$ROOT/content"
[ -d app/dist ] || { echo "✗ app/dist tak ada — jalankan 'npm run build' di app/ dulu" >&2; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"
cp -R server "$OUT/server"
cp -R engine "$OUT/engine"
cp -R app/dist "$OUT/dist"
# PENTING: server/ berisi DATA FONT ASLI (projects/workspace/log) — JANGAN ikut dibundel/publik.
rm -rf "$OUT/server/projects" "$OUT/server/workspace"
find "$OUT" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT" \( -name '*.pyc' -o -name '*.log' \) -delete 2>/dev/null || true

CVER=$(git rev-list --count HEAD 2>/dev/null || echo 0)   # versi isi = jumlah commit (monotonik)
printf '{"content":%s,"minApp":"%s"}\n' "$CVER" "$MIN_APP" > "$OUT/meta.json"
echo "✓ content siap: v$CVER (minApp $MIN_APP) → $OUT"
