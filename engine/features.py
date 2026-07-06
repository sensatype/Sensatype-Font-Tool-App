"""
Generasi fitur OpenType (.fea) dari konvensi NAMA glyph — auto, tanpa editor .fea (PRD D5).

Dideteksi dari nama glyph di UFO:
  - LIGATURE: nama dgn underscore  (f_i, f_f_i, c_t)  -> feature `liga` / `dlig`
      `sub <komponen...> by <ligatur>;`  (komponen = nama dipisah '_', harus ada sbg glyph)
      f-ligature & ligatur umum -> liga; sisanya -> dlig. Aturan diurut komponen terbanyak dulu.
  - ALTERNATE: nama dgn suffix titik
      base.ssNN  -> feature ssNN (Stylistic Set)
      base.salt / base.alt / base.altN / base.cvNN -> feature salt
      semuanya juga masuk `aalt` (Access All Alternates).
  - MULTILINGUAL precomposed (é, ñ, ...) cukup lewat cmap; ditambah languagesystem latn.

kern & mark tetap di-generate otomatis oleh ufo2ft (feature writers) saat kompilasi —
modul ini hanya menambah GSUB (liga/alt). Ditulis ke font.features.text.
"""
from __future__ import annotations

import re

_RE_SS = re.compile(r"^ss\d{2}$")
_RE_SALT = re.compile(r"^(salt|alt\d*|cv\d{2})$")
# ligatur "umum" -> liga (selain ini -> dlig)
_LIGA_STD = {
    ("f", "f"), ("f", "i"), ("f", "l"), ("f", "f", "i"), ("f", "f", "l"),
    ("f", "b"), ("f", "h"), ("f", "k"), ("f", "j"), ("f", "t"), ("f", "f", "j"),
    ("i", "j"),
}


def _fmt_rule_components(parts):
    return " ".join(parts)


def generate(font) -> str:
    names = set(font.keys())

    # --- ligatures ---
    liga, dlig = [], []
    for n in names:
        if "_" not in n or "." in n:
            continue
        parts = n.split("_")
        if len(parts) < 2 or not all(p in names for p in parts):
            continue  # komponen tak lengkap -> lewati
        (liga if tuple(parts) in _LIGA_STD or parts[0] == "f" else dlig).append((parts, n))
    # urut komponen terbanyak dulu (ffi sebelum fi)
    liga.sort(key=lambda x: -len(x[0]))
    dlig.sort(key=lambda x: -len(x[0]))

    # --- alternates ---
    ss = {}          # "ss01" -> [(base, alt)]
    salt = []        # [(base, alt)]
    aalt = {}        # base -> [alt, ...]
    for n in names:
        if "." not in n:
            continue
        base, _, suffix = n.partition(".")
        if not base or base not in names:
            continue
        if _RE_SS.match(suffix):
            ss.setdefault(suffix, []).append((base, n))
            aalt.setdefault(base, []).append(n)
        elif _RE_SALT.match(suffix):
            salt.append((base, n))
            aalt.setdefault(base, []).append(n)

    # --- rakit .fea ---
    lines = ["languagesystem DFLT dflt;", "languagesystem latn dflt;", ""]

    def feature_block(tag, rules):
        if not rules:
            return
        lines.append(f"feature {tag} {{")
        for parts, lig in rules:
            lines.append(f"    sub {_fmt_rule_components(parts)} by {lig};")
        lines.append(f"}} {tag};\n")

    feature_block("liga", liga)
    feature_block("dlig", dlig)

    for tag in sorted(ss):
        lines.append(f"feature {tag} {{")
        for base, alt in ss[tag]:
            lines.append(f"    sub {base} by {alt};")
        lines.append(f"}} {tag};\n")

    if salt:
        lines.append("feature salt {")
        for base, alt in salt:
            lines.append(f"    sub {base} by {alt};")
        lines.append("} salt;\n")

    if aalt:
        lines.append("feature aalt {")
        for base in sorted(aalt):
            alts = " ".join(aalt[base])
            lines.append(f"    sub {base} from [{alts}];")
        lines.append("} aalt;\n")

    return "\n".join(lines).strip() + "\n"


def summary(font) -> dict:
    """Ringkasan fitur terdeteksi (untuk UI)."""
    names = set(font.keys())
    ligs = [n for n in names if "_" in n and "." not in n
            and all(p in names for p in n.split("_"))]
    alts = [n for n in names if "." in n and n.partition(".")[0] in names
            and (_RE_SS.match(n.partition(".")[2]) or _RE_SALT.match(n.partition(".")[2]))]
    ss_tags = sorted({n.partition(".")[2] for n in alts if _RE_SS.match(n.partition(".")[2])})
    return {
        "ligatures": sorted(ligs),
        "alternates": sorted(alts),
        "stylisticSets": ss_tags,
    }
