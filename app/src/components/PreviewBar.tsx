import { memo, useState } from "react";
import { PREVIEW_FAMILY } from "../font";

// teks uji standar tipografi (pangram, angka, pasangan kerning rawan)
const SAMPLES: { label: string; text: string }[] = [
  { label: "Hamburgevons", text: "Hamburgevons" },
  { label: "Pangram EN", text: "The quick brown fox jumps over the lazy dog" },
  { label: "Pangram ID", text: "Muharjo seorang xenofobia universal yang takut pada warga jazirah, contohnya Qatar" },
  { label: "Kapital", text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
  { label: "Minuscule", text: "abcdefghijklmnopqrstuvwxyz" },
  { label: "Angka & tanda", text: "0123456789 ¿?¡!()[]{}«»“”·—" },
  { label: "Pasangan kern", text: "AV AW AT LT Ta Te To Tr Ty Va Vo WA Wa We Ya Yo r. v. w. y." },
];

// memo: tak ikut re-render tiap commit edit (editV) — hanya saat fontV/tracking/axis berubah
export const PreviewBar = memo(function PreviewBar({ fontV, varSettings, tracking = 0 }: { fontV: number; varSettings?: string; tracking?: number }) {
  const [text, setText] = useState("Hamburgevons");
  const [size, setSize] = useState(64);
  const upm = 1000; // tracking em → px: tracking * size / upm (letter-spacing)
  return (
    <div className="border-t shrink-0" style={{ borderColor: "var(--border)", background: "var(--bg-2)" }}>
      <div className="flex items-center gap-3 px-4 py-2">
        <input
          className="field flex-1"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ketik teks preview…"
        />
        <select className="field !w-auto !py-1.5 text-xs" value="" title="Isi dengan teks uji standar"
          onChange={(e) => e.target.value && setText(e.target.value)}>
          <option value="">Contoh…</option>
          {SAMPLES.map((s) => <option key={s.label} value={s.text}>{s.label}</option>)}
        </select>
        <input
          type="range" min={24} max={160} value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          style={{ accentColor: "var(--accent)", width: 120 }}
        />
        <span className="text-faint text-xs tabular-nums w-10">{size}px</span>
      </div>
      <div className="px-4 pb-4 overflow-x-auto">
        <div
          key={fontV}
          style={{
            fontFamily: PREVIEW_FAMILY,
            fontSize: size,
            color: "var(--glyph)",
            lineHeight: 1.25,
            whiteSpace: "nowrap",
            fontVariationSettings: varSettings,
            letterSpacing: tracking ? (tracking * size) / upm : undefined, // tracking global live
          }}
        >
          {text || " "}
        </div>
      </div>
    </div>
  );
});
