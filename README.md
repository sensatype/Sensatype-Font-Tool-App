# Sensatype Font Tool

Satu pipeline **SVG → OTF / TTF / WOFF / WOFF2** menggantikan Fontself + FontLab.
Lihat [PRD.md](PRD.md) untuk gambaran utuh, [CONTEXT.md](CONTEXT.md) untuk status terkini.

## Komponen
- `engine/` — engine Python (impor SVG → UFO → spacing/kerning seed → fontmake → 4 format). Headless, teruji.
- `server/` — API lokal FastAPI yang membungkus engine (Fase 3).
- `app/` — UI React + Vite (Tailwind, dark pro). Dites di browser; Electron = Fase 4.

## Setup (sekali)
```bash
cd "Sensatype FontLab"
python3 -m venv .venv && source .venv/bin/activate
pip install -r engine/requirements.txt -r server/requirements.txt
cd app && npm install && cd ..
```

## Menjalankan UI (Fase 3)
Dua proses (dua terminal), atau backend di background:

```bash
# 1) Backend (API lokal)
source .venv/bin/activate
uvicorn server.app:app --reload --port 8000

# 2) Frontend (Vite dev — proxy /api ke :8000)
cd app && npm run dev          # buka http://localhost:5173
```

Alur di UI: **Import** (specimen grid + layout, atau multi-SVG) → **glyph grid + preview live** →
**edit spacing** (geser bar / ketik) & **kerning** (per kelas) → **Metadata** → **Export** (zip 4 format).

## Engine langsung (tanpa UI, headless)
```bash
source .venv/bin/activate
# specimen penuh -> per-glyph
python engine/specimen_split.py --input "svg/Yoruna Full.svg" --out glyphs --layout yoruna-full
# build font
python engine/smoke_test.py --input glyphs --out build --family Yoruna \
    --autospace --kern --preset display-serif
```
Detail flag: [engine/README.md](engine/README.md).

## Mesin
Dev/test di **MacBook Air M1** (venv lokal). JANGAN di Mac Mini server (PRD §6, §12).
