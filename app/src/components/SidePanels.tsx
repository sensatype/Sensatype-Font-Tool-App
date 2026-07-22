import { useEffect, useMemo, useRef, useState } from "react";
import { Kanban, Tag, Sparkle, Cube, CircleNotch } from "@phosphor-icons/react";
import { api } from "../api";
import { PREVIEW_FAMILY } from "../font";
import type { KernListEntry, KernSide, ProjectState } from "../types";

export function SidePanels({
  project,
  selected,
  axisVal,
  setAxisVal,
  busy,
  setBusy,
  onProject,
  onMeta,
  fontV,
  tracking = 0,
  width,
}: {
  project: ProjectState;
  selected: string | null;
  axisVal: number | null;
  setAxisVal: (v: number) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onProject: (s: ProjectState) => void;
  onMeta: (s: ProjectState) => void;
  fontV: number;
  tracking?: number;
  width?: number;
}) {
  const [tab, setTab] = useState<"kern" | "feat" | "vf" | "meta">("kern");
  return (
    <aside className="shrink-0 border-l flex flex-col" style={{ width: width ?? 320, borderColor: "var(--border)", background: "var(--bg-2)" }}>
      <div className="flex border-b" style={{ borderColor: "var(--border)" }}>
        <Tab active={tab === "kern"} onClick={() => setTab("kern")} icon={<Kanban className="size-4" />}>Kern</Tab>
        <Tab active={tab === "feat"} onClick={() => setTab("feat")} icon={<Sparkle className="size-4" />}>Fitur</Tab>
        <Tab active={tab === "vf"} onClick={() => setTab("vf")} icon={<Cube className="size-4" />}>VF</Tab>
        <Tab active={tab === "meta"} onClick={() => setTab("meta")} icon={<Tag className="size-4" />}>Meta</Tab>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {tab === "kern" && <KerningPanel project={project} selected={selected} fontV={fontV} tracking={tracking} />}
        {tab === "feat" && <FeaturesPanel project={project} />}
        {tab === "vf" && (
          <VFPanel project={project} axisVal={axisVal} setAxisVal={setAxisVal}
            busy={busy} setBusy={setBusy} onProject={onProject} />
        )}
        {tab === "meta" && <MetadataPanel project={project} onMeta={onMeta} />}
      </div>
    </aside>
  );
}

function VFPanel({
  project, axisVal, setAxisVal, busy, setBusy, onProject,
}: {
  project: ProjectState;
  axisVal: number | null;
  setAxisVal: (v: number) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onProject: (s: ProjectState) => void;
}) {
  const axis = project.axis;
  const masters = project.masters ?? [];
  const fileRef = useRef<HTMLInputElement>(null);
  const [ax, setAx] = useState({ tag: "wght", name: "Weight", min: 400, max: 700, default: 400 });
  const [mval, setMval] = useState(700);
  const [mstyle, setMstyle] = useState("Bold");
  const [err, setErr] = useState<string | null>(null);

  async function setupAxis() {
    setBusy(true); setErr(null);
    try { onProject(await api.setAxis(ax)); } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(false); }
  }
  async function addMaster(file: File) {
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file); fd.append("value", String(mval)); fd.append("style", mstyle);
      onProject(await api.addMaster(fd));
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(false); }
  }

  if (!axis) {
    return (
      <div className="flex flex-col gap-3">
        <div className="label">Variable font — tetapkan axis</div>
        <p className="text-faint text-[11px] leading-relaxed">
          Tetapkan satu axis lalu tambah ≥1 master di lokasi axis lain (mis. Bold@700).
          Master WAJIB kompatibel interpolasi (glyph & titik sama).
        </p>
        <div className="grid grid-cols-2 gap-2">
          <L label="Tag"><input className="field" value={ax.tag} onChange={(e) => setAx({ ...ax, tag: e.target.value })} /></L>
          <L label="Nama"><input className="field" value={ax.name} onChange={(e) => setAx({ ...ax, name: e.target.value })} /></L>
          <L label="Min"><input className="field" type="number" value={ax.min} onChange={(e) => setAx({ ...ax, min: +e.target.value })} /></L>
          <L label="Max"><input className="field" type="number" value={ax.max} onChange={(e) => setAx({ ...ax, max: +e.target.value })} /></L>
          <L label="Default"><input className="field" type="number" value={ax.default} onChange={(e) => setAx({ ...ax, default: +e.target.value })} /></L>
        </div>
        <button className="btn btn-accent justify-center" onClick={setupAxis} disabled={busy}>
          {busy ? "…" : "Aktifkan axis"}
        </button>
        {err && <div className="text-bad text-xs whitespace-pre-wrap">{err}</div>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="label">{axis.name} ({axis.tag})</span>
          <span className="tabular-nums font-medium">{axisVal ?? axis.default}</span>
        </div>
        <input
          type="range" min={axis.min} max={axis.max} value={axisVal ?? axis.default}
          disabled={!project.variable}
          onChange={(e) => setAxisVal(Number(e.target.value))}
          style={{ accentColor: "var(--accent)", width: "100%" }}
        />
        <div className="flex justify-between text-faint text-[11px] mt-0.5">
          <span>{axis.min}</span><span>{axis.max}</span>
        </div>
        {!project.variable && (
          <p className="text-warn text-[11px] mt-1">Tambah ≥1 master lagi agar slider menginterpolasi.</p>
        )}
      </div>

      <div>
        <div className="label mb-1.5">Masters · {masters.length}</div>
        <div className="flex flex-col gap-1">
          {masters.map((m, i) => (
            <div key={i} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg"
              style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }}>
              <span className="font-medium">{m.name}</span>
              <span className="text-muted tabular-nums text-xs">{axis.tag} {m.value ?? axis.default}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-3 flex flex-col gap-2" style={{ background: "var(--panel-2)" }}>
        <div className="label">Tambah master (SVG specimen kompatibel)</div>
        <div className="flex gap-2">
          <L label="Style"><input className="field" value={mstyle} onChange={(e) => setMstyle(e.target.value)} /></L>
          <L label={axis.tag}><input className="field" type="number" value={mval} onChange={(e) => setMval(+e.target.value)} /></L>
        </div>
        <button className="btn justify-center" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Memproses…" : "Pilih SVG master"}
        </button>
        <input ref={fileRef} type="file" accept=".svg" hidden
          onChange={(e) => e.target.files?.[0] && addMaster(e.target.files[0])} />
      </div>
      {err && <div className="text-bad text-xs whitespace-pre-wrap">{err}</div>}
      <p className="text-faint text-[11px] leading-relaxed">
        Preview di grid & teks memakai font-variation-settings — geser slider untuk melihat interpolasi.
        Export menghasilkan variable font dalam 4 format (.otf CFF2, .ttf, .woff, .woff2).
      </p>
    </div>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 flex-1">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function FeaturesPanel({ project }: { project: ProjectState }) {
  const feat = project.features ?? { ligatures: [], alternates: [], stylisticSets: [] };
  const tags = useMemo(() => {
    const t: string[] = [];
    if (feat.ligatures.length) t.push("liga", "dlig");
    t.push(...feat.stylisticSets);
    if (feat.alternates.some((a) => /\.(salt|alt|cv)/.test(a))) t.push("salt");
    t.push("kern");
    return [...new Set(t)];
  }, [feat]);

  const [on, setOn] = useState<Record<string, boolean>>({ kern: true, liga: true });
  const [text, setText] = useState("fi ffi · AV · café");

  const ffs = Object.entries(on)
    .map(([t, v]) => `"${t}" ${v ? 1 : 0}`)
    .join(", ");

  const total = feat.ligatures.length + feat.alternates.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="card grid place-items-center py-6 px-3" style={{ background: "var(--canvas)" }}>
        <div style={{ fontFamily: PREVIEW_FAMILY, fontSize: 46, color: "var(--glyph)", lineHeight: 1.1, fontFeatureSettings: ffs, textAlign: "center" }}>
          {text}
        </div>
      </div>
      <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Teks uji fitur…" />

      <div>
        <div className="label mb-2">Toggle fitur (OpenType)</div>
        {tags.length === 0 ? (
          <p className="text-faint text-xs">Belum ada fitur terdeteksi.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <button
                key={t}
                onClick={() => setOn((o) => ({ ...o, [t]: !o[t] }))}
                className="px-2.5 py-1 rounded-md text-xs font-medium tabular-nums transition"
                style={{
                  background: on[t] ? "var(--accent)" : "var(--panel-2)",
                  color: on[t] ? "#fff" : "var(--muted)",
                  border: `1px solid ${on[t] ? "var(--accent)" : "var(--border)"}`,
                }}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <Detected label="Ligatur" items={feat.ligatures} />
      <Detected label="Alternate" items={feat.alternates} />

      <p className="text-faint text-[11px] leading-relaxed">
        {total > 0
          ? `${total} glyph fitur terdeteksi dari konvensi nama (f_i = liga, A.ss01 = stylistic set, a.salt = alternate). Fitur di-generate otomatis (.fea) saat export.`
          : "Tambah glyph alternate (A.ss01), ligatur (f_i), atau multilingual (Aacute) — via file SVG bernama atau baris specimen. Fitur OpenType di-generate otomatis."}
      </p>
    </div>
  );
}

function Detected({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="label mb-1.5">{label} · {items.length}</div>
      <div className="flex flex-wrap gap-1">
        {items.map((g) => (
          <code key={g} className="px-1.5 py-0.5 rounded text-[11px]" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>{g}</code>
        ))}
      </div>
    </div>
  );
}

function Tab({ active, onClick, icon, children }: any) {
  return (
    <button
      onClick={onClick}
      className="flex-1 flex items-center justify-center gap-2 py-2.5 font-medium transition"
      style={{
        color: active ? "var(--text)" : "var(--muted)",
        borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
        background: active ? "var(--panel)" : "transparent",
      }}
    >
      {icon}
      {children}
    </button>
  );
}

// DAFTAR kerning yang SUDAH ADA (read-only, menyusul editor). Pencarian + limit di server
// (font bisa punya puluhan ribu pasangan). Nilai diatur di editor (mode Kerning / Text → Atur kern).
function KerningPanel({
  project,
  selected,
  fontV,
}: {
  project: ProjectState;
  selected: string | null;
  fontV: number;
  tracking?: number;
}) {
  const selChar = project.glyphs?.find((g) => g.name === selected)?.char ?? "";
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ pairs: KernListEntry[]; total: number; matched: number } | null>(null);
  const [loading, setLoading] = useState(false);
  // fetch (debounce) saat query / fontV (editV) berubah → daftar selalu menyusul editor
  useEffect(() => {
    let live = true; setLoading(true);
    const t = setTimeout(() => {
      api.kernList(q.trim() || undefined, 400)
        .then((r) => { if (live) { setData(r); setLoading(false); } })
        .catch(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q, fontV]);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div>
        <div className="label mb-1.5">Daftar Kerning</div>
        <input className="field w-full" placeholder="Cari pasangan (huruf / kelas)…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex items-center gap-2 mt-1.5 text-[11px] text-faint">
          <span>{data ? `${data.matched.toLocaleString()} cocok · ${data.total.toLocaleString()} total` : "…"}</span>
          <span className="ml-auto flex gap-2">
            {selChar && <button className="underline hover:text-muted" onClick={() => setQ(selChar)}>Glyph ini ({selChar})</button>}
            {q && <button className="underline hover:text-muted" onClick={() => setQ("")}>Hapus</button>}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto -mx-1">
        {loading && !data ? (
          <div className="grid place-items-center py-10 text-faint"><CircleNotch className="size-5 animate-spin" /></div>
        ) : data && data.pairs.length ? (
          <ul className="flex flex-col">
            {data.pairs.map((p, i) => <KernRow key={i} p={p} />)}
          </ul>
        ) : (
          <div className="text-faint text-sm text-center py-10">Tak ada pasangan{q ? ` untuk "${q}"` : ""}.</div>
        )}
      </div>

      {data && data.matched > data.pairs.length && (
        <p className="text-faint text-[11px]">Menampilkan {data.pairs.length} teratas (|nilai| terbesar). Persempit dengan pencarian.</p>
      )}
      <p className="text-faint text-[11px] leading-relaxed">
        Daftar <b>read-only</b> — nilai diatur di editor (mode <b>Kerning</b>, atau mode <b>Text</b> → <b>Atur kern</b>).
        Kerning disimpan di level kelas; satu pasangan memengaruhi semua glyph se-kelas.
      </p>
    </div>
  );
}

function KernRow({ p }: { p: KernListEntry }) {
  return (
    <li className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-[var(--bg)]">
      <KernTok s={p.left} />
      <span className="text-faint text-xs">×</span>
      <KernTok s={p.right} />
      <span className="ml-auto tabular-nums font-semibold shrink-0" style={{ color: p.value < 0 ? "#e5654b" : "var(--good)" }}>
        {p.value > 0 ? `+${p.value}` : p.value}
      </span>
    </li>
  );
}

function KernTok({ s }: { s: KernSide }) {
  return (
    <span className="inline-flex items-center gap-1 min-w-0"
      title={s.isGroup ? `Kelas ${s.label}${s.size ? ` (${s.size} glyph)` : ""}` : s.label}>
      <span className="truncate font-medium">{s.char || s.label}</span>
      {s.isGroup && <span className="text-[9px] px-1 rounded shrink-0" style={{ background: "var(--bg)", color: "var(--faint)" }}>kls</span>}
    </span>
  );
}

const META: { key: string; label: string; ph?: string }[] = [
  { key: "family", label: "Family" },
  { key: "style", label: "Style" },
  { key: "version", label: "Version", ph: "1.0" },
  { key: "designer", label: "Designer" },
  { key: "designerURL", label: "Designer URL" },
  { key: "license", label: "License" },
  { key: "licenseURL", label: "License URL" },
  { key: "copyright", label: "Copyright" },
  { key: "trademark", label: "Trademark" },
  { key: "sampleText", label: "Sample text" },
];

function MetadataPanel({ project, onMeta }: { project: ProjectState; onMeta: (s: ProjectState) => void }) {
  const init: Record<string, string> = {
    family: project.family ?? "",
    style: project.style ?? "",
    ...(project.metadata ?? {}),
  };
  const [form, setForm] = useState(init);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const st = await api.setMetadata(form);
      onMeta(st);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {META.map((f) => (
        <label key={f.key} className="flex flex-col gap-1">
          <span className="label">{f.label}</span>
          {f.key === "sampleText" ? (
            <textarea className="field" rows={2} value={form[f.key] ?? ""} placeholder={f.ph}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
          ) : (
            <input className="field" value={form[f.key] ?? ""} placeholder={f.ph}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
          )}
        </label>
      ))}
      <button className="btn btn-accent justify-center mt-1" onClick={save} disabled={saving}>
        {saving ? "Menyimpan…" : saved ? "Tersimpan ✓" : "Simpan metadata"}
      </button>
      <p className="text-faint text-[11px]">Ditulis ke OpenType name table saat export.</p>
    </div>
  );
}
