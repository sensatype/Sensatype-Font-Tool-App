"""
Preset loader + klasifikasi kategori glyph (slot "preset" PRD D6).

Preset = bundel parameter HTLS + reference glyph per kategori. Reference per kategori
membuat spasi konsisten dalam satu kategori (semua kapital diukur thd zona 'H', dst.) —
pemakaian HT Letterspacer yang benar.

Drop-in masa depan: Gemma memilih preset otomatis untuk batch besar (PRD D6) — cukup
mengisi nama preset; struktur ini tidak berubah.
"""
from __future__ import annotations

import json
from pathlib import Path as FsPath

_PRESETS_PATH = FsPath(__file__).with_name("presets.json")


def load(path=None):
    return json.loads(FsPath(path or _PRESETS_PATH).read_text(encoding="utf-8"))


def get_preset(name=None, path=None):
    data = load(path)
    name = name or data.get("default")
    presets = data.get("presets", {})
    if name not in presets:
        raise KeyError(f"Preset '{name}' tidak ada. Tersedia: {', '.join(presets)}")
    return name, presets[name]


def spacing_mode(preset_data) -> str:
    """"optical" (HTLS, bawaan) atau "edge" (margin tetap dari ujung ink kiri/kanan).

    Mode "edge" memberi SEMUA glyph margin yang sama dari ujung inknya. Lebih mudah ditebak,
    tapi beban pindah ke kerning: pada Yoruna, pasangan huruf yang butuh kerning naik 69%→88%
    dan median |kern| 29→55 unit, karena selisih optik (O butuh ~20 unit lebih rapat dari H)
    tak lagi ditangani spacing. Disediakan sbg pilihan sadar, bukan bawaan."""
    return (preset_data or {}).get("spacing", "optical")


def edge_margin(preset_data, upm=1000, override=None) -> int:
    """Margin mode "edge" dlm unit font. Nilai preset ditulis pada skala upm 1000 lalu diskalakan.
    `override` = nilai per-project (project.json → edgeMargin) bila pengguna menyetelnya."""
    m = override if override is not None else (preset_data or {}).get("margin", 60)
    return int(round(float(m) * (upm or 1000) / 1000.0))


def category_of(codepoint) -> str:
    """Kategori kasar dari codepoint (cukup untuk pemilihan reference HTLS)."""
    if not codepoint:
        return "other"
    if 0x41 <= codepoint <= 0x5A:
        return "uppercase"
    if 0x61 <= codepoint <= 0x7A:
        return "lowercase"
    if 0x30 <= codepoint <= 0x39:
        return "figures"
    return "other"


def reference_for(preset: dict, category: str):
    cats = preset.get("categories", {})
    cat = cats.get(category)
    return cat.get("reference") if cat else None
