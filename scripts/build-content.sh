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
# PENTING: server/ berisi DATA FONT ASLI (projects/workspace/log) + token login — JANGAN dibundel/publik.
rm -rf "$OUT/server/projects" "$OUT/server/workspace"
# kern-memory.json = memori kerapatan pengguna (nama pasangan + nilai kern dari fontnya = IP font).
# Di aplikasi terpasang ia ada di userData, tapi backend yang dijalankan DARI SUMBER menaruhnya di
# server/ — tanpa baris ini ia ikut terbundel lalu terbit publik.
find "$OUT" -name 'kern-memory.json' -delete 2>/dev/null || true
find "$OUT" -name 'auth-token.json' -delete 2>/dev/null || true
find "$OUT" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$OUT" \( -name '*.pyc' -o -name '*.log' \) -delete 2>/dev/null || true

# SMOKE IMPORT — wajib, dan sengaja MEMATIKAN build bila gagal.
# Backend beku memuat isi lewat run_backend._add_content_to_path(), yang hanya menaruh <content>
# di sys.path — BUKAN <content>/server. Modul server yang diimpor absolut (`import foo`) karena
# itu jalan mulus di dev/uji (di sana server/ ada di sys.path) tapi mati di aplikasi terpasang.
# Matinya saat IMPOR → backend tak pernah menyala → jendela berhenti di "Memuat…" selamanya, tanpa
# petunjuk apa pun. Pernah terjadi pd v72 (server/kernmem.py). Diuji DI SINI, sebelum terbit.
PYBIN="$ROOT/.venv/bin/python"
if [ -x "$PYBIN" ]; then
  echo "→ Uji impor (meniru aplikasi terpasang)…"
  SMOKE_TMP="$(mktemp -d)"
  if ! SENSATYPE_ENGINE_DIR="$OUT/engine" SENSATYPE_PROJECTS_DIR="$SMOKE_TMP/projects" \
       "$PYBIN" -c "
import sys; sys.path.insert(0, '$OUT')
import server.app as A
n = len([r for r in A.app.routes if getattr(r, 'path', '').startswith('/api/')])
assert n > 30, f'route /api terlalu sedikit ({n}) — isi tak lengkap?'
print(f'  ✓ server.app terimpor · {n} route /api')
"; then
    rm -rf "$SMOKE_TMP"
    echo "✗ Isi TIDAK bisa diimpor seperti cara aplikasi terpasang memuatnya — build dihentikan." >&2
    echo "  Penyebab tersering: modul baru di server/ diimpor absolut (import foo)." >&2
    exit 1
  fi
  rm -rf "$SMOKE_TMP"
else
  echo "⚠ .venv tidak ada — uji impor DILEWATI. Isi belum tentu bisa dimuat aplikasi terpasang." >&2
fi

CVER=$(git rev-list --count HEAD 2>/dev/null || echo 0)   # versi isi = jumlah commit (monotonik)
printf '{"content":%s,"minApp":"%s"}\n' "$CVER" "$MIN_APP" > "$OUT/meta.json"
echo "✓ content siap: v$CVER (minApp $MIN_APP) → $OUT"
