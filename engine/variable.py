"""
Variable font: multi-master UFO + designspace -> VF (PRD §5/§7).

UFO = sumber kebenaran per master; designspace mengikat master ke lokasi axis;
fontmake mengompilasi jadi satu variable font. Browser merender VF langsung
(font-variation-settings) → slider axis di UI menggerakkan preview tanpa rebuild.

Syarat interpolasi (PRD §9.7): semua master WAJIB kompatibel — glyph set sama,
jumlah & urutan titik/kontur sama per glyph, kerning group sama. Bila tidak, fontmake gagal.
"""
from __future__ import annotations

from pathlib import Path

from fontTools.designspaceLib import (
    AxisDescriptor,
    AxisLabelDescriptor,
    DesignSpaceDocument,
    InstanceDescriptor,
    SourceDescriptor,
)


def _glyph_signature(g):
    """Struktur titik (untuk cek kompatibilitas interpolasi): per kontur, urutan tipe titik."""
    return tuple(tuple((p.type or "off") for p in c) for c in g)


def _unify_kern_groups(fonts, default):
    """§9.7: kerning group WAJIB IDENTIK di semua master.

    Grup kern diturunkan dari OUTLINE tiap master (kerning.build_kerning → _side_signature,
    yang mengkuantisasi kedalaman sisi ke bucket upm*0.04). Master dgn bobot/lebar berbeda
    bisa melewati batas bucket → PEMBAGIAN GRUP BERBEDA (mis. master A: kern1.D=[D,O,Q],
    master B: kern1.D=[D] + kern1.O terpisah). Akibatnya fontmake gagal / kerning VF salah —
    dan harmonize() dulu hanya menyamakan outline, tak pernah menyentuh groups.

    Grup master DEFAULT dipakai sbg KANONIK; kerning master lain di-RE-KEY ke sana (kunci lama
    diresolusi ke glyph wakil, lalu dipetakan ke grup kanonik). Nilai yang bertabrakan pada
    kunci kanonik yang sama dirata-ratakan. Return jumlah master yang diseragamkan.
    """
    canon = {k: list(v) for k, v in default.groups.items() if k.startswith("public.kern")}
    if not canon:
        return 0
    side1 = {g: k for k, ms in canon.items() if k.startswith("public.kern1.") for g in ms}
    side2 = {g: k for k, ms in canon.items() if k.startswith("public.kern2.") for g in ms}

    fixed = 0
    for f in fonts:
        if f is default:
            continue
        if {k: list(v) for k, v in f.groups.items() if k.startswith("public.kern")} == canon:
            continue  # sudah identik

        def canon_key(key, side_map):
            """Kunci kerning bisa nama GRUP atau nama GLYPH. Hanya kunci GRUP yang di-re-key ke
            grup kanonik; kunci level-glyph adalah EXCEPTION (scope='pair') yang sengaja lebih
            spesifik dari kelas — dipromosikan ke kelas akan menghapus exception-nya."""
            members = f.groups.get(key)
            if members is None:
                return key
            return side_map.get(members[0], members[0])

        merged = {}
        for (L, R), v in dict(f.kerning).items():
            merged.setdefault((canon_key(L, side1), canon_key(R, side2)), []).append(float(v))
        f.kerning.clear()
        for k, vals in merged.items():
            # clamp ke rentang GPOS int16 (konsisten dgn project.set_kerning)
            f.kerning[k] = max(-32767, min(32767, int(round(sum(vals) / len(vals)))))

        for k in [k for k in f.groups if k.startswith("public.kern")]:
            del f.groups[k]
        for k, ms in canon.items():
            f.groups[k] = list(ms)
        fixed += 1
    return fixed


def harmonize(masters, default_value, out_dir):
    """Samakan master agar bisa di-VF: glyph yang struktur titiknya BEDA antar master
    dibuat STATIS (outline master default disalin ke semua master → delta nol, tak berinterpolasi).

    masters = [(ufo_path, value, name)]. Return (harmonized=[(path,value,name)], static=[...]).
    """
    import ufoLib2

    fonts = [(ufoLib2.Font.open(p), v, nm) for p, v, nm in masters]
    default = next((f for f, v, _ in fonts if v == default_value), fonts[0][0])

    common = set(fonts[0][0].keys())
    for f, _, _ in fonts[1:]:
        common &= set(f.keys())

    static = []
    for name in sorted(common):
        sigs = {_glyph_signature(f[name]) for f, _, _ in fonts}
        if len(sigs) > 1:  # tidak kompatibel → jadikan statis
            static.append(name)
            src = default[name]
            for f, _, _ in fonts:
                if f is default:
                    continue
                g = f[name]
                g.clearContours()
                g.clearComponents()
                src.draw(g.getPen())
                g.width = src.width

    # §9.7: selain outline, KERNING GROUP juga wajib identik antar-master (lihat docstring modul).
    # Dikerjakan di sini karena harmonize() satu-satunya titik semua master bertemu sebelum
    # designspace/fontmake — jadi project lama yang grupnya sudah terlanjur divergen ikut sembuh.
    _unify_kern_groups([f for f, _, _ in fonts], default)

    out_dir.mkdir(parents=True, exist_ok=True)
    harmonized = []
    for f, v, nm in fonts:
        hp = out_dir / f"master_{int(v)}.ufo"
        f.save(hp, overwrite=True)
        harmonized.append((hp, v, nm))
    return harmonized, static


def build_designspace(masters, axis, out_path: Path, family="Font"):
    """masters = [(ufo_path, value, name), ...]; axis = {tag,name,min,max,default}.

    Menambah sources + named instances + axis labels (STAT) sehingga VF punya
    fvar named-instances (Thin/Regular/Black) dan tabel STAT.
    """
    doc = DesignSpaceDocument()
    ax = AxisDescriptor()
    ax.tag = axis["tag"]
    ax.name = axis["name"]
    ax.minimum = axis["min"]
    ax.maximum = axis["max"]
    ax.default = axis["default"]
    default_val = axis["default"]

    # STAT: label per lokasi master (yang di default = elidable)
    labels = []
    for _p, val, name in sorted(masters, key=lambda m: m[1]):
        labels.append(AxisLabelDescriptor(
            name=name, userValue=val, elidable=(val == default_val)))
    ax.axisLabels = labels
    doc.addAxis(ax)

    for ufo_path, val, name in masters:
        s = SourceDescriptor()
        s.path = str(ufo_path)
        s.location = {axis["name"]: val}
        if val == default_val:
            s.copyInfo = True
        doc.addSource(s)

        inst = InstanceDescriptor()
        inst.location = {axis["name"]: val}
        inst.familyName = family
        inst.styleName = name
        doc.addInstance(inst)

    doc.write(str(out_path))
    return out_path


def compile_variable(designspace_path: Path, out_dir: Path, cff2=False):
    """Kompilasi designspace -> variable font. cff2=False → glyf VF (.ttf);
    cff2=True → juga CFF2 VF (.otf). Return dict {'ttf': path, 'otf': path?}."""
    from fontmake.font_project import FontProject

    out_dir.mkdir(parents=True, exist_ok=True)
    # panggilan terpisah per format (gabungan bisa error 'TTFont has no attribute lib')
    FontProject().run_from_designspace(
        str(designspace_path), output=("variable",), output_dir=str(out_dir))
    res = {}
    ttf = next(iter(sorted(out_dir.rglob("*.ttf"))), None)
    if not ttf:
        raise RuntimeError(f"fontmake tidak menghasilkan VF di {out_dir}")
    res["ttf"] = ttf
    if cff2:
        try:
            FontProject().run_from_designspace(
                str(designspace_path), output=("variable-cff2",), output_dir=str(out_dir))
            otf = next(iter(sorted(out_dir.rglob("*.otf"))), None)
            if otf:
                res["otf"] = otf
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠ CFF2 VF (.otf) gagal, lewati: {e}")
    return res
