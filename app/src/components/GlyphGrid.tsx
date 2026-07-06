import { memo, useMemo, useState } from "react";
import { PREVIEW_FAMILY } from "../font";
import type { Glyph } from "../types";

const CAT_LABEL: Record<string, string> = {
  uppercase: "Uppercase",
  lowercase: "Lowercase",
  figures: "Number",
  multilingual: "Multilingual",
  alternate: "Alternate",
  ligature: "Ligature",
  other: "Punctuation",
};
const CAT_ORDER = ["uppercase", "lowercase", "figures", "multilingual", "alternate", "ligature", "other"];

// memo: App re-render tiap commit edit (editV) — grid ±200 tombol tak perlu ikut
// bila glyphs/fontV/seleksi tak berubah (mis. commit kerning) → render jauh lebih ringan.
export const GlyphGrid = memo(function GlyphGrid({
  glyphs,
  selected,
  onSelect,
  fontV,
  varSettings,
  width,
}: {
  glyphs: Glyph[];
  selected: string | null;
  onSelect: (n: string) => void;
  fontV: number;
  varSettings?: string;
  width?: number;
}) {
  // pencarian: karakter persis (mis. "A", "…") ATAU potongan nama glyph (mis. "acute", "ss01", "f_i")
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const n = q.trim();
    if (!n) return glyphs;
    const lo = n.toLowerCase();
    return glyphs.filter((g) => g.char === n || g.name.toLowerCase().includes(lo));
  }, [glyphs, q]);

  const groups = useMemo(() => {
    const m: Record<string, Glyph[]> = {};
    for (const g of shown) (m[g.category] ??= []).push(g);
    return m;
  }, [shown]);

  const nameToChar = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of glyphs) if (g.char) m.set(g.name, g.char);
    return m;
  }, [glyphs]);

  // Sel alt/liga tak punya char → render bentuk asli via fitur OpenType di font live:
  // alternate A.ss01 → "A" + feature ss01; ligatur R_U → "RU" + liga/dlig.
  function display(g: Glyph): { text: string; feat?: string } {
    if (g.char) return { text: g.char };
    if (g.category === "alternate" && g.name.includes(".")) {
      const [base, suf] = g.name.split(".");
      return { text: nameToChar.get(base) ?? base, feat: `"${suf}" 1` };
    }
    if (g.category === "ligature" && g.name.includes("_")) {
      const t = g.name.split("_").map((c) => nameToChar.get(c) ?? c).join("");
      return { text: t, feat: `"liga" 1, "dlig" 1` };
    }
    return { text: "·" };
  }

  return (
    <aside
      className="shrink-0 border-r overflow-auto"
      style={{ width: width ?? 288, borderColor: "var(--border)", background: "var(--bg-2)" }}
    >
      <div className="sticky top-0 z-10 px-2 pt-2 pb-1.5 backdrop-blur h-11"
        style={{ background: "color-mix(in srgb, var(--bg-2) 92%, transparent)" }}>
        <input className="field w-full !py-1 text-xs" placeholder="Cari glyph… (karakter / nama)"
          value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {q.trim() && !shown.length && (
        <p className="text-faint text-xs px-3 py-2">Tidak ada glyph cocok “{q.trim()}”.</p>
      )}
      {CAT_ORDER.filter((c) => groups[c]?.length).map((cat) => (
        <div key={cat}>
          <div
            className="label sticky top-11 px-3 py-2 backdrop-blur"
            style={{ background: "color-mix(in srgb, var(--bg-2) 86%, transparent)" }}
          >
            {CAT_LABEL[cat]} <span className="text-faint">· {groups[cat].length}</span>
          </div>
          <div className="grid grid-cols-5 gap-1.5 px-2.5 pb-3">
            {groups[cat].map((g) => {
              const active = g.name === selected;
              const disp = display(g);
              const fs = disp.text.length > 2 ? 16 : disp.text.length === 2 ? 21 : 26;
              return (
                <button
                  key={g.name}
                  onClick={() => onSelect(g.name)}
                  title={`${g.name}  ·  adv ${g.advance}`}
                  className="aspect-square rounded-lg grid place-items-center relative transition overflow-hidden"
                  style={{
                    background: active ? "var(--accent)" : "var(--panel)",
                    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                    color: active ? "#fff" : "var(--glyph)",
                  }}
                >
                  <span
                    key={fontV}
                    style={{ fontFamily: PREVIEW_FAMILY, fontSize: fs, lineHeight: 1, fontVariationSettings: varSettings, fontFeatureSettings: disp.feat }}
                  >
                    {disp.text}
                  </span>
                  <span
                    className="absolute bottom-0.5 right-1 text-[9px]"
                    style={{ color: active ? "rgba(255,255,255,.6)" : "var(--faint)" }}
                  >
                    {g.contours >= 2 ? "◎" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </aside>
  );
});
