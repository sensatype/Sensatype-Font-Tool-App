"""
HT Letterspacer — port pure-Python untuk UFO (ufoLib2).

Port setia dari algoritma inti HT Letterspacer (Huerta Tipografica, Apache-2.0):
  https://github.com/huertatipografica/HTLetterspacer  (htls/engine.py)

Yang diport = matematika geometri/area (pure-Python di engine asli):
  - scanline margins (kiri/kanan ink per ketinggian y),
  - depth limit proporsional xHeight (abaikan ceruk dalam spt 'c'),
  - penutupan counter 45 derajat + polygon area (shoelace),
  - normalisasi area thd UPM & xHeight -> sidebearing baru.

Yang TIDAK diport (khusus Glyphs / fase berikut):
  - rules/config per kategori + reference glyph per kategori (slot "preset", PRD D6),
  - komponen/metric-keys, brace/bracket layer, stroke expansion.
  Untuk v1 ini = SEED: factor 1, reference = glyph itu sendiri (atau --reference manual).
  Sesuai CONTEXT D7: auto memberi seed, manual yang memutuskan.

Catatan korektness (PRD §9): semua dalam unit em; mengukur OUTLINE BERSIH (sudah
di-import & dibersihkan), bukan SVG mentah.
"""
from __future__ import annotations

import math
from fontTools.pens.basePen import BasePen


# --- titik mutable (diagonize memodifikasi .x) ------------------------------
class P:
    __slots__ = ("x", "y")

    def __init__(self, x, y):
        self.x = float(x)
        self.y = float(y)


# --- flatten outline -> polilinies (untuk scanline & bounds) ----------------
class _FlattenPen(BasePen):
    def __init__(self, glyphSet=None, steps=16):
        super().__init__(glyphSet)
        self.steps = steps
        self.contours = []
        self._cur = []

    def _moveTo(self, pt):
        self._cur = [pt]

    def _lineTo(self, pt):
        self._cur.append(pt)

    def _curveToOne(self, p1, p2, p3):
        p0 = self._getCurrentPoint()
        for i in range(1, self.steps + 1):
            t = i / self.steps
            mt = 1 - t
            x = mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0]
            y = mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]
            self._cur.append((x, y))

    def _qCurveToOne(self, p1, p2):
        p0 = self._getCurrentPoint()
        for i in range(1, self.steps + 1):
            t = i / self.steps
            mt = 1 - t
            x = mt**2 * p0[0] + 2 * mt * t * p1[0] + t**2 * p2[0]
            y = mt**2 * p0[1] + 2 * mt * t * p1[1] + t**2 * p2[1]
            self._cur.append((x, y))

    def _closePath(self):
        if self._cur:
            self.contours.append(self._cur)
            self._cur = []

    def _endPath(self):
        if self._cur:
            self.contours.append(self._cur)
            self._cur = []


def _flatten(glyph, steps=16):
    pen = _FlattenPen(steps=steps)
    glyph.draw(pen)
    return pen.contours


def _bounds(contours):
    xs = [p[0] for poly in contours for p in poly]
    ys = [p[1] for poly in contours for p in poly]
    return min(xs), min(ys), max(xs), max(ys)  # xMin,yMin,xMax,yMax


def _margins_at(contours, y):
    """Leftmost & rightmost ink x pada ketinggian y (None bila tak ada ink)."""
    xs = []
    for poly in contours:
        n = len(poly)
        for i in range(n):
            x1, y1 = poly[i]
            x2, y2 = poly[(i + 1) % n]
            if (y1 <= y < y2) or (y2 <= y < y1):
                t = (y - y1) / (y2 - y1)
                xs.append(x1 + t * (x2 - x1))
    if not xs:
        return None, None
    return min(xs), max(xs)


# --- area polygon (shoelace; verbatim) --------------------------------------
def _area(points):
    s = 0.0
    n = len(points)
    for i in range(-1, n - 1):
        s += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y
    return abs(s) * 0.5


def _triangle(angle, y):
    return y * math.tan(math.radians(angle))


# ---------------------------------------------------------------------------
class HTLS:
    """Hitung sidebearing seed untuk satu glyph (no write).

    upm, xheight, angle: metrik font.  area/depth/over: parameter HTLS.
    """

    def __init__(self, upm=1000, xheight=500, angle=0.0,
                 area=400.0, depth=15.0, over=0.0, freq=5):
        self.upm = upm
        self.xHeight = xheight
        self.angle = angle
        self.paramArea = float(area)
        self.paramDepth = float(depth)
        self.paramOver = float(over)
        self.freq = max(1, int(freq))
        self.effectiveArea = self.paramArea
        self.effectiveDepth = self.paramDepth
        self.minYref = self.maxYref = self.minY = self.maxY = 0.0

    # --- margins lengkap (dengan default utk baris kosong) ------------------
    def _total_margin_list(self, contours, b):
        minX, minY, maxX, maxY = b
        origin = minX
        dfltDepth = (maxX - minX)  # angle 0
        listL, listR = [], []
        result = False
        y = self.minY
        while y <= self.maxY:
            lpos, rpos = _margins_at(contours, y)
            slantPosL = origin + _triangle(self.angle, y) + dfltDepth
            slantPosR = origin + _triangle(self.angle, y)
            if lpos is not None:
                listL.append(P(lpos, y))
                if self.minYref <= y <= self.maxYref:
                    result = True
            else:
                listL.append(P(slantPosL, y))
            if rpos is not None:
                listR.append(P(rpos, y))
                if self.minYref <= y <= self.maxYref:
                    result = True
            else:
                listR.append(P(slantPosR, y))
            y += self.freq
        if result:
            return listL, listR
        return False, False

    @staticmethod
    def _zone(margins, minY, maxY):
        return [p for p in margins if minY <= p.y <= maxY]

    @staticmethod
    def _max_points(listL, listR):
        left = min(listL, key=lambda p: p.x)
        right = max(listR, key=lambda p: p.x)
        return P(left.x, left.y), P(right.x, right.y)

    def _set_depth(self, mL, mR, lExtreme, rExtreme):
        depth = self.xHeight * self.effectiveDepth / 100
        maxdepth = lExtreme.x + depth
        mindepth = rExtreme.x - depth
        mL = [P(min(p.x, maxdepth), p.y) for p in mL]
        mR = [P(max(p.x, mindepth), p.y) for p in mR]
        # padding di luar tinggi glyph hingga zona referensi
        y = mL[0].y - self.freq
        while y > self.minYref:
            mL.insert(0, P(maxdepth, y))
            mR.insert(0, P(mindepth, y))
            y -= self.freq
        y = mL[-1].y + self.freq
        while y < self.maxYref:
            mL.append(P(maxdepth, y))
            mR.append(P(mindepth, y))
            y += self.freq
        return mL, mR

    def _diagonize(self, mL, mR):
        ystep = abs(mL[0].y - mL[1].y) if len(mL) > 1 else self.freq
        for i in range(len(mL) - 1):
            if mL[i + 1].x - mL[i].x > ystep:
                mL[i + 1].x = mL[i].x + ystep
            if mR[i + 1].x - mR[i].x < -ystep:
                mR[i + 1].x = mR[i].x - ystep
        for i in reversed(range(len(mL) - 1)):
            if mL[i].x - mL[i + 1].x > ystep:
                mL[i].x = mL[i + 1].x + ystep
            if mR[i].x - mR[i + 1].x < -ystep:
                mR[i].x = mR[i + 1].x - ystep
        return mL, mR

    def _close_counters(self, margin, extreme):
        margin.insert(0, P(extreme.x, self.minYref))
        margin.append(P(extreme.x, self.maxYref))
        return margin

    def _sb_value(self, polygon):
        amplitudeY = self.maxYref - self.minYref
        areaUPM = self.effectiveArea * ((self.upm / 1000) ** 2)
        whiteArea = areaUPM * 100.0
        propArea = (amplitudeY * whiteArea) / self.xHeight
        valor = propArea - _area(polygon)
        return valor / amplitudeY

    def sidebearings(self, glyph, reference_contours=None):
        """Return (newL, newR) atau None bila glyph kosong / di luar zona."""
        contours = _flatten(glyph)
        if not contours:
            return None
        b = _bounds(contours)
        ref_b = _bounds(reference_contours) if reference_contours else b

        over = self.xHeight * self.paramOver / 100
        self.minYref = ref_b[1] - over
        self.maxYref = ref_b[3] + over
        self.minY = b[1]
        self.maxY = b[3]

        lTot, rTot = self._total_margin_list(contours, b)
        if not lTot and not rTot:
            return None
        lZone = self._zone(lTot, self.minYref, self.maxYref)
        rZone = self._zone(rTot, self.minYref, self.maxYref)
        if not lZone or not rZone:
            return None

        lFull, rFull = self._max_points(lTot, rTot)
        lExt, rExt = self._max_points(lZone, rZone)

        # processMargins
        lZone, rZone = self._set_depth(lZone, rZone, lExt, rExt)
        lZone, rZone = self._diagonize(lZone, rZone)
        lPoly = self._close_counters(lZone, lExt)
        rPoly = self._close_counters(rZone, rExt)

        distanceL = math.ceil(lExt.x - lFull.x)
        distanceR = math.ceil(rFull.x - rExt.x)

        newL = math.ceil(0 - distanceL + self._sb_value(lPoly))
        newR = math.ceil(0 - distanceR + self._sb_value(rPoly))
        return newL, newR


# --- apply ke glyph ufoLib2 (geser outline + set advance) -------------------
def apply_sidebearings(glyph, font, newL, newR):
    """Set LSB=newL & RSB=newR: geser outline supaya xMin=newL, lalu width=xMax+newR.

    PRD §9.4: kontrol = TRANSLASI posisi saja, tidak menderivasi ulang bentuk.
    """
    bounds = glyph.getBounds(font)
    if bounds is None:
        return
    dx = newL - bounds.xMin
    for contour in glyph:
        for pt in contour:
            pt.x += dx
    new_xmax = bounds.xMax + dx
    glyph.width = round(new_xmax + newR)
