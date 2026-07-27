"""
Memori kerapatan LINTAS-PROJECT, per PENGGUNA.

Yang disimpan adalah BUKTI MENTAH, bukan kesimpulan: tiap pasangan yang ditetapkan pengguna
dicatat sebagai (saran sistem, nilai pengguna, irama font saat itu). Kesimpulan — kerapatan &
kecenderungan spasi — dihitung ULANG tiap kali dibaca. Akibatnya menambah bukti baru langsung
memperbaiki tebakan tanpa migrasi data, dan kalau rumusnya kelak diperbaiki, seluruh riwayat
ikut terkoreksi sendiri.

IRAMA FONT (flat_target) ikut disimpan per sampel karena kecenderungan SPASI hanya bisa dibawa
antar-font bila dinyatakan sbg PECAHAN dari irama font itu sendiri. "−52 unit" tak berarti apa-apa
di font yang spasi alaminya beda; "−0,34 × irama" berarti sama di mana pun.

Berkas: <induk PROJECTS_ROOT>/kern-memory.json — lokal di perangkat, tak pernah diunggah, dan
tak ikut ke bundel konten (build-content.sh membuang server/projects & workspace).

TAK ADA mekanisme belajar tersembunyi: seluruh isinya bisa dibaca lewat summary(), ditampilkan
apa adanya di UI, dan dihapus lewat forget().
"""
from __future__ import annotations

import json
import statistics
import time
from pathlib import Path

VERSION = 1
MAX_SAMPLES = 2000          # per pengguna; bukti terlama dibuang lebih dulu
_MIN_SAMPLES = 3            # di bawah ini kesimpulan tak dilaporkan (terlalu sedikit utk dipercaya)


def _path(projects_root: Path) -> Path:
    return Path(projects_root).parent / "kern-memory.json"


def _load(projects_root: Path) -> dict:
    p = _path(projects_root)
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(d, dict) and isinstance(d.get("users"), dict):
            return d
    except Exception:                      # noqa: BLE001 — berkas hilang/rusak → mulai bersih
        pass
    return {"version": VERSION, "users": {}}


def _save(projects_root: Path, data: dict) -> None:
    p = _path(projects_root)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".json.tmp")   # tulis-lalu-ganti: berkas tak pernah setengah jadi
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(p)
    except Exception:                      # noqa: BLE001 — memori adalah kenyamanan, bukan data
        pass                               # sumber; gagal menulis TIDAK boleh menggagalkan edit


def _uid(user_id) -> str:
    """Pengguna tanpa identitas (auth dimatikan / luring) tetap punya lacinya sendiri."""
    u = str(user_id or "").strip()
    return u or "lokal"


def record(projects_root: Path, user_id, project_id: str, samples: list[dict]) -> int:
    """Catat bukti. `samples` = [{"left","right","base","value","rhythm"}].

    Kunci = "project|L R" → menyetel ulang pasangan yang sama MENGGANTI bukti lama, bukan
    menumpuknya. Tanpa itu pengguna yang menyetel satu pasangan sepuluh kali akan membuat
    pasangan itu sepuluh kali lebih berbobot dari yang lain.
    """
    ok = [s for s in samples
          if isinstance(s.get("base"), (int, float)) and isinstance(s.get("value"), (int, float))
          and isinstance(s.get("rhythm"), (int, float)) and s["rhythm"] > 0]
    if not ok:
        return 0
    data = _load(projects_root)
    u = data["users"].setdefault(_uid(user_id), {"samples": {}})
    store = u.setdefault("samples", {})
    now = int(time.time())
    for s in ok:
        store[f"{project_id}|{s['left']} {s['right']}"] = {
            "b": round(float(s["base"]), 2), "v": round(float(s["value"]), 2),
            "r": round(float(s["rhythm"]), 2), "at": now,
        }
    if len(store) > MAX_SAMPLES:           # buang yang terlama
        for k in sorted(store, key=lambda k: store[k].get("at", 0))[: len(store) - MAX_SAMPLES]:
            store.pop(k, None)
    u["updatedAt"] = now
    data["version"] = VERSION
    _save(projects_root, data)
    return len(ok)


def forget(projects_root: Path, user_id) -> int:
    """Hapus seluruh bukti milik satu pengguna. Return jumlah sampel yang dibuang."""
    data = _load(projects_root)
    u = data["users"].pop(_uid(user_id), None)
    n = len(u.get("samples", {})) if u else 0
    if n or u is not None:
        _save(projects_root, data)
    return n


def drop_project(projects_root: Path, user_id, project_id: str) -> int:
    """Buang bukti dari satu project (dipakai saat project dihapus — bukti tanpa project
    asal tak bisa lagi ditelusuri pengguna, dan itu melanggar 'tak ada mekanisme tersembunyi')."""
    data = _load(projects_root)
    u = data["users"].get(_uid(user_id))
    if not u:
        return 0
    store = u.get("samples", {})
    dead = [k for k in store if k.split("|", 1)[0] == project_id]
    for k in dead:
        store.pop(k, None)
    if dead:
        u["updatedAt"] = int(time.time())
        _save(projects_root, data)
    return len(dead)


def summary(projects_root: Path, user_id) -> dict:
    """Kesimpulan dari SELURUH bukti pengguna. Tak menulis apa pun.

    Dua model dinilai pada bukti yang SAMA (lihat Project.kern_taste — menyaring bukti lebih
    dulu sama saja memilih pemenang duluan):
      · RASIO   : pengali koreksi optik. Hanya bisa dihitung dari sampel bersaran ≠ 0 & searah,
                  tapi DINILAI pada semua sampel (di saran 0 ia meramalkan 0 — melesetnya nyata).
      · SELISIH : (nilai − saran) ÷ irama font. Bisa dihitung dari semua sampel.
    Sisa galat keduanya dinormalkan ke irama font agar sampel lintas-font sebanding.
    """
    data = _load(projects_root)
    u = data["users"].get(_uid(user_id)) or {}
    store = u.get("samples", {})
    out = {"samples": len(store), "projects": 0, "ratio": None, "deltaFrac": None,
           "fit": None, "residualRatio": None, "residualDelta": None,
           "updatedAt": u.get("updatedAt"), "enough": False}
    if not store:
        return out
    out["projects"] = len({k.split("|", 1)[0] for k in store})
    evid = [(s["b"], s["v"], s["r"]) for s in store.values() if s.get("r", 0) > 0]
    if len(evid) < _MIN_SAMPLES:
        return out                          # terlalu sedikit → jangan mengaku tahu apa-apa
    ratios = [v / b for b, v, _ in evid if b and v / b > 0]
    dfrac = statistics.median([(v - b) / r for b, v, r in evid])
    med_r = statistics.median(ratios) if ratios else None
    res_d = statistics.median([abs(v - (b + dfrac * r)) / r for b, v, r in evid])
    res_r = statistics.median([abs(v - b * med_r) / r for b, v, r in evid]) if med_r else None
    out.update({
        "enough": True,
        "usedForRatio": len(ratios),
        "ratio": round(med_r, 3) if med_r else None,
        "deltaFrac": round(dfrac, 3),
        "residualDelta": round(res_d, 3),
        "residualRatio": round(res_r, 3) if res_r is not None else None,
        # ambang 0,9 sama dgn kern_taste: sedikit berpihak pada rasio saat nyaris seri, karena
        # menerapkan rasio aman (pasangan lurus tetap 0, lantai anti-tabrakan tetap menjaga)
        "fit": "delta" if (res_r is None or res_d < res_r * 0.9) else "ratio",
    })
    return out
