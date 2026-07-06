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
