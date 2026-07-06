"""
Perapih node/handle: hapus titik yang TIDAK dibutuhkan tanpa merusak bentuk.

Bekerja pada kontur terstruktur (format editor): list titik {x, y, type, smooth},
type ∈ {"move","line","curve","qcurve","offcurve"}. Empat operasi, semua DIJAGA
toleransi (simpangan bentuk maks, unit em) — kalau melampaui, titik TIDAK dihapus:

  1. Buang segmen nol (dua on-curve menumpuk).
  2. Kubik yang sebenarnya lurus → jadikan garis (handle dibuang).
  3. Node di tengah dua garis yang segaris → dihapus.
  4. Dua kubik bertetangga dgn tangen menerus (smooth) → dicoba dilebur jadi SATU kubik
     (least-squares pada panjang handle, arah tangen dipertahankan); diterima hanya bila
     simpangan sampel < toleransi.

Kontur dgn qcurve (TrueType) hanya mendapat operasi 1 & 3 (aman).
"""
from __future__ import annotations

import math

_EPS = 1e-9


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _perp_dist(p, a, b):
    """Jarak titik p ke ruas garis a-b."""
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 < _EPS:
        return _dist(p, a)
    t = ((px - ax) * dx + (py - ay) * dy) / L2
    t = max(0.0, min(1.0, t))
    return _dist(p, (ax + t * dx, ay + t * dy))


def _bez(p0, p1, p2, p3, t):
    u = 1 - t
    return (u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1])


def _norm(v):
    L = math.hypot(v[0], v[1])
    return (v[0] / L, v[1] / L) if L > _EPS else None


# ── parsing kontur ⇄ segmen ────────────────────────────────────────────────────
def _parse(contour):
    """-> (anchors, segs) | None. anchors[i] = dict titik on-curve. segs[i] = offcurve list
    MENUJU anchor[i] (dari anchor[i-1], siklik). None bila pola tak didukung (qcurve dsb.)."""
    pts = list(contour)
    n = len(pts)
    if n < 2:
        return None
    if any(p["type"] == "move" for p in pts):
        return None  # kontur TERBUKA — asumsi siklik tak berlaku, jangan disentuh
    start = next((i for i, p in enumerate(pts) if p["type"] != "offcurve"), None)
    if start is None:
        return None
    pts = pts[start:] + pts[:start]
    anchors, segs, cur = [], [], []
    for p in pts:
        if p["type"] == "offcurve":
            cur.append(p)
        else:
            anchors.append(dict(p))
            segs.append(cur)
            cur = []
    if cur:  # offcurve sisa di ujung → milik segmen menuju anchor pertama
        segs[0] = cur + segs[0]
    segs = segs[1:] + segs[:1]  # geser: segs[i] = offs dari anchors[i] → anchors[i+1]
    for i, s in enumerate(segs):
        if len(s) not in (0, 2):
            return None  # qcurve / pola aneh → jangan disentuh
        a2 = anchors[(i + 1) % len(anchors)]
        if len(s) == 2 and a2["type"] not in ("curve",):
            return None
        if len(s) == 0 and a2["type"] not in ("line", "move"):
            a2["type"] = "line"
    return anchors, segs


def _rebuild(anchors, segs):
    out = []
    m = len(anchors)
    for i in range(m):
        a = dict(anchors[i])
        a["type"] = "curve" if len(segs[(i - 1) % m]) == 2 else "line"
        out.append(a)
        for o in segs[i]:
            out.append(dict(o))
    # putar agar offcurve segmen terakhir mendarat SEBELUM anchor pertama sesuai konvensi?
    # Konvensi editor: offcurve mendahului on-curve tujuannya. Susun ulang: tiap anchor diikuti
    # offs segmen KELUARnya — offs terakhir menuju anchor pertama sudah berada di ekor. Valid.
    return out


def _seg_points(anchors, segs, i, k=13):
    """Sampel k titik segmen i (anchor i → anchor i+1)."""
    m = len(anchors)
    a = anchors[i]; b = anchors[(i + 1) % m]
    p0 = (a["x"], a["y"]); p3 = (b["x"], b["y"])
    s = segs[i]
    if len(s) == 2:
        p1 = (s[0]["x"], s[0]["y"]); p2 = (s[1]["x"], s[1]["y"])
        return [_bez(p0, p1, p2, p3, j / (k - 1)) for j in range(k)]
    return [(p0[0] + (p3[0] - p0[0]) * j / (k - 1), p0[1] + (p3[1] - p0[1]) * j / (k - 1)) for j in range(k)]


# ── operasi ────────────────────────────────────────────────────────────────────
def _drop_zero(anchors, segs, tol):
    """Op 1: segmen nol — anchor menumpuk. Hapus anchor i BERSAMA segmen keluarnya (index sama
    di kedua list → alignment anchors↔segs terjaga utk semua posisi, termasuk wrap)."""
    m = len(anchors)
    if m < 3:
        return False
    for i in range(m):
        j = (i + 1) % m
        if not segs[i] and _dist((anchors[i]["x"], anchors[i]["y"]), (anchors[j]["x"], anchors[j]["y"])) <= max(tol * 0.5, 0.5):
            del anchors[i]
            del segs[i]
            return True
    return False


def _flatten_straight_curves(anchors, segs, tol):
    """Op 2: kubik yang praktis lurus → garis."""
    m = len(anchors)
    for i in range(m):
        if len(segs[i]) != 2:
            continue
        a = (anchors[i]["x"], anchors[i]["y"])
        b = (anchors[(i + 1) % m]["x"], anchors[(i + 1) % m]["y"])
        c1 = (segs[i][0]["x"], segs[i][0]["y"])
        c2 = (segs[i][1]["x"], segs[i][1]["y"])
        # batas simpangan kubik dari talinya ≤ 3/4 jarak maks kontrol→tali
        if max(_perp_dist(c1, a, b), _perp_dist(c2, a, b)) * 0.75 <= tol:
            segs[i] = []
            return True
    return False


def _drop_collinear(anchors, segs, tol):
    """Op 3: node di antara dua GARIS yang segaris."""
    m = len(anchors)
    if m < 3:
        return False
    for i in range(m):
        prev = (i - 1) % m
        if segs[prev] or segs[i]:
            continue  # kedua sisi harus garis
        a = (anchors[prev]["x"], anchors[prev]["y"])
        p = (anchors[i]["x"], anchors[i]["y"])
        b = (anchors[(i + 1) % m]["x"], anchors[(i + 1) % m]["y"])
        if _perp_dist(p, a, b) <= tol:
            del anchors[i]
            del segs[i]
            return True
    return False


def _merge_curves(anchors, segs, tol):
    """Op 4: lebur dua kubik di node bertangen menerus jadi satu kubik (cek simpangan sampel)."""
    m = len(anchors)
    if m < 3:
        return False
    for i in range(m):
        prev = (i - 1) % m
        if len(segs[prev]) != 2 or len(segs[i]) != 2:
            continue
        P0 = (anchors[prev]["x"], anchors[prev]["y"])
        A = (anchors[i]["x"], anchors[i]["y"])
        P6 = (anchors[(i + 1) % m]["x"], anchors[(i + 1) % m]["y"])
        c2 = (segs[prev][1]["x"], segs[prev][1]["y"])  # handle masuk node A
        c4 = (segs[i][0]["x"], segs[i][0]["y"])        # handle keluar node A
        tin = _norm((A[0] - c2[0], A[1] - c2[1]))
        tout = _norm((c4[0] - A[0], c4[1] - A[1]))
        if not tin or not tout:
            continue
        if tin[0] * tout[0] + tin[1] * tout[1] < 0.985 and not anchors[i].get("smooth"):
            continue  # sudut disengaja (tangen belok >~10°) & tidak ditandai smooth → jangan lebur
        u = _norm((segs[prev][0]["x"] - P0[0], segs[prev][0]["y"] - P0[1])) or tin
        w = _norm((segs[i][1]["x"] - P6[0], segs[i][1]["y"] - P6[1])) or (-tout[0], -tout[1])
        # sampel komposit asli + parameter panjang-tali
        S = _seg_points(anchors, segs, prev) + _seg_points(anchors, segs, i)[1:]
        acc, ts = 0.0, [0.0]
        for k in range(1, len(S)):
            acc += _dist(S[k - 1], S[k])
            ts.append(acc)
        if acc < _EPS:
            continue
        ts = [t / acc for t in ts]
        # least-squares panjang handle a,b: B(t) = base(t) + a·f1(t)·u + b·f2(t)·w
        A11 = A12 = A22 = b1 = b2 = 0.0
        for t, s in zip(ts, S):
            uu = 1 - t
            f1 = 3 * uu * uu * t
            f2 = 3 * uu * t * t
            bx = (uu ** 3 + f1) * P0[0] + (t ** 3 + f2) * P6[0]
            by = (uu ** 3 + f1) * P0[1] + (t ** 3 + f2) * P6[1]
            rx, ry = s[0] - bx, s[1] - by
            A11 += f1 * f1
            A12 += f1 * f2 * (u[0] * w[0] + u[1] * w[1])
            A22 += f2 * f2
            b1 += f1 * (u[0] * rx + u[1] * ry)
            b2 += f2 * (w[0] * rx + w[1] * ry)
        det = A11 * A22 - A12 * A12
        if abs(det) < _EPS:
            continue
        a_len = (b1 * A22 - b2 * A12) / det
        b_len = (b2 * A11 - b1 * A12) / det
        if a_len < 0 or b_len < 0:
            continue  # geometri aneh → jangan paksa
        Q1 = (P0[0] + a_len * u[0], P0[1] + a_len * u[1])
        Q2 = (P6[0] + b_len * w[0], P6[1] + b_len * w[1])
        err = max(_dist(s, _bez(P0, Q1, Q2, P6, t)) for t, s in zip(ts, S))
        if err > tol:
            continue
        # terima: ganti dua segmen dgn satu; node A hilang
        segs[prev] = [
            {"x": round(Q1[0], 1), "y": round(Q1[1], 1), "type": "offcurve", "smooth": False},
            {"x": round(Q2[0], 1), "y": round(Q2[1], 1), "type": "offcurve", "smooth": False},
        ]
        del anchors[i]
        del segs[i]
        return True
    return False


def simplify_contours(contours, tolerance=3.0):
    """Rapikan semua kontur. `tolerance` = simpangan bentuk maksimum (unit em)."""
    tol = max(0.5, float(tolerance))
    out = []
    for contour in contours:
        parsed = _parse(contour)
        if not parsed:
            out.append(contour)  # qcurve/pola tak dikenal → biarkan apa adanya
            continue
        anchors, segs = parsed
        for _ in range(400):  # sampai stabil (tiap op menghapus ≥1 titik → pasti berhenti)
            if _drop_zero(anchors, segs, tol):
                continue
            if _flatten_straight_curves(anchors, segs, tol):
                continue
            if _drop_collinear(anchors, segs, tol):
                continue
            if _merge_curves(anchors, segs, tol):
                continue
            break
        if len(anchors) < 2:
            continue  # kontur habis/degenerate → buang
        out.append(_rebuild(anchors, segs))
    return out
