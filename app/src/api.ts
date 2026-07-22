import type { ContourPoint, GlyphDetail, GlyphRender, KernInfo, KernListEntry, KernMode, KernPair, ProjectState, StagingState } from "./types";

const BASE = "/api";

// Dipanggil saat backend membalas 401 (token dicabut/kedaluwarsa) → AuthGate balik ke login.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

async function j<T>(r: Response): Promise<T> {
  if (r.status === 401) {
    onUnauthorized?.();
    throw new Error("Perlu login");
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || r.statusText);
  }
  return r.json();
}

export type ProjectSummary = {
  id: string; family: string; style?: string | null; preset?: string | null;
  glyphCount: number | null; updatedAt: number; active: boolean;
};

export const api = {
  getProject: () => fetch(`${BASE}/project`).then(j<ProjectState>),

  // --- pustaka multi-project (device-per-user) ---
  projects: () => fetch(`${BASE}/projects`).then(j<{ projects: ProjectSummary[]; active: string | null }>),
  createProject: (body: { family: string; style: string }) =>
    fetch(`${BASE}/projects`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(j<{ id: string; state: ProjectState }>),
  openProject: (id: string) =>
    fetch(`${BASE}/projects/${encodeURIComponent(id)}/open`, { method: "POST" }).then(j<ProjectState>),
  deleteProject: (id: string) =>
    fetch(`${BASE}/projects/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then(j<{ projects: ProjectSummary[]; active: string | null }>),
  renameProject: (id: string, family: string) =>
    fetch(`${BASE}/projects/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ family }),
    }).then(j<{ projects: ProjectSummary[]; active: string | null }>),

  layouts: () => fetch(`${BASE}/layouts`).then(j<{ layouts: string[] }>),

  importSpecimen: (form: FormData) =>
    fetch(`${BASE}/import/specimen`, { method: "POST", body: form }).then(j<ProjectState>),

  importGlyphs: (form: FormData) =>
    fetch(`${BASE}/import/glyphs`, { method: "POST", body: form }).then(j<ProjectState>),

  // --- staging import wizard ---
  stageImport: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return fetch(`${BASE}/import/stage`, { method: "POST", body: form }).then(j<StagingState>);
  },
  getStaging: () => fetch(`${BASE}/import/staging`).then(j<StagingState>),
  stagingOp: (op: string, ids: number[]) =>
    fetch(`${BASE}/import/staging/op`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ids }),
    }).then(j<StagingState>),
  stagingMove: (ids: number[], dx: number, dy: number) =>
    fetch(`${BASE}/import/staging/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, dx, dy }),
    }).then(j<StagingState>),
  setGuides: (guides: { id?: number; y: number; type: string; linked?: boolean }[]) =>
    fetch(`${BASE}/import/staging/guides`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guides }),
    }).then(j<StagingState>),
  stagingUndo: () => fetch(`${BASE}/import/staging/undo`, { method: "POST" }).then(j<StagingState>),
  stagingRedo: () => fetch(`${BASE}/import/staging/redo`, { method: "POST" }).then(j<StagingState>),
  commitImport: (body: { tokens: string[]; family: string; style: string; preset: string }) =>
    fetch(`${BASE}/import/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<ProjectState>),
  importProgress: () =>
    fetch(`${BASE}/import/progress`).then(
      j<{ pct: number; phase: string; active: boolean; error: string | null }>),

  glyph: (name: string) =>
    fetch(`${BASE}/glyph/${encodeURIComponent(name)}`).then(j<GlyphDetail>),

  // SEMUA tulisan editor memakai recompile:false (tulis UFO cepat ~0.3s, TANPA compile webfont
  // ~2.3s per commit). Webfont di-recompile SEKALI via /preview/recompile (debounce di App).
  setSpacing: (name: string, body: { lsb?: number; rsb?: number }) =>
    fetch(`${BASE}/glyph/${encodeURIComponent(name)}/spacing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, recompile: false }),
    }).then(j<{ lsb: number; rsb: number; advance: number }>),

  setMetrics: (body: { ascender?: number; descender?: number; capHeight?: number; xHeight?: number }) =>
    fetch(`${BASE}/metrics`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, recompile: false }),
    }).then(j<{ ascender: number; descender: number; capHeight: number; xHeight: number }>),

  // Rapatkan sidebearing SEMUA glyph ke ink (LSB=0 & RSB=0) → batas = node terluar.
  fitAll: () => fetch(`${BASE}/fit-all`, { method: "POST" })
    .then(j<{ fitted: number; total: number; skipped: number }>),

  // Rapikan node/handle: hapus titik berlebih, bentuk dipertahankan (toleransi = simpangan maks, em)
  simplifyGlyph: (name: string, tolerance: number) =>
    fetch(`${BASE}/glyph/${encodeURIComponent(name)}/simplify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tolerance, recompile: false }),
    }).then(j<GlyphDetail>),

  setOutline: (name: string, contours: ContourPoint[][]) =>
    fetch(`${BASE}/glyph/${encodeURIComponent(name)}/outline`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contours, recompile: false }),
    }).then(j<GlyphDetail>),

  setAnchors: (name: string, anchors: { name: string; x: number; y: number }[]) =>
    fetch(`${BASE}/glyph/${encodeURIComponent(name)}/anchors`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anchors }),
    }).then(j<GlyphDetail>),

  setComponents: (name: string, components: { base: string; transform: number[] }[]) =>
    fetch(`${BASE}/glyph/${encodeURIComponent(name)}/components`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ components, recompile: false }),
    }).then(j<GlyphDetail>),

  getKerning: (left: string, right: string) =>
    fetch(`${BASE}/kerning?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`)
      .then(j<KernInfo>),

  kernList: (q?: string, limit = 400) =>
    fetch(`${BASE}/kerning/list?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}`)
      .then(j<{ pairs: KernListEntry[]; total: number; matched: number }>),

  // Smart kern: saran kern optikal (sadar-bentuk) utk satu pasangan — read-only.
  // mode = kerapatan pilihan user (dekat/sedang/jauh); pasangan LURUS tetap 0 di semua mode.
  smartKern: (left: string, right: string, mode: KernMode = "medium") =>
    fetch(`${BASE}/kerning/smart?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}&mode=${mode}`)
      .then(j<{ left: string; right: string; value: number; mode: KernMode }>),

  // Geser SEMUA nilai kerning tersimpan sebesar delta (bake permanen — scope "Semuanya").
  shiftAllKern: (delta: number) =>
    fetch(`${BASE}/kerning/shift-all`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta, recompile: false }),
    }).then(j<{ shifted: number; kerning: number }>),

  // Nolkan SEMUA nilai kerning (grup kelas dipertahankan) — untuk project yang sudah ada.
  clearAllKern: () => fetch(`${BASE}/kerning/clear-all`, { method: "POST" })
    .then(j<{ cleared: number }>),

  // Auto-kern optikal SELURUH pasangan huruf & angka. onlyEmpty → tak menimpa yang sudah ada.
  autoKernAll: (onlyEmpty = true, mode: KernMode = "medium") =>
    fetch(`${BASE}/kerning/auto`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onlyEmpty, recompile: false, mode }),
    }).then(j<{ candidates: number; computed: number; written: number; skipped: number; mode: KernMode }>),

  setKerning: (body: { left: string; right: string; value: number; scope?: "class" | "pair"; recompile?: boolean }) =>
    fetch(`${BASE}/kerning`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<KernInfo>),

  recompilePreview: () => fetch(`${BASE}/preview/recompile`, { method: "POST" }).then(j<{ version: number }>),

  glyphsRender: () => fetch(`${BASE}/glyphs/render`).then(j<{ glyphs: Record<string, GlyphRender> }>),

  setTracking: (value: number) =>
    fetch(`${BASE}/tracking`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    }).then(j<ProjectState>),

  expandKernGroups: () => fetch(`${BASE}/kerning/expand-groups`, { method: "POST" })
    .then(j<{ merged: number; variants: number; groups: number; kerning: number }>),

  setMetadata: (body: Record<string, string>) =>
    fetch(`${BASE}/metadata`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<ProjectState>),

  respace: (preset?: string) =>
    fetch(`${BASE}/respace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset }),
    }).then(j<ProjectState>),

  setAxis: (body: { tag: string; name: string; min: number; max: number; default: number }) =>
    fetch(`${BASE}/axis`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<ProjectState>),

  addMaster: (form: FormData) =>
    fetch(`${BASE}/master`, { method: "POST", body: form }).then(j<ProjectState>),

  previewUrl: (version?: number) => `${BASE}/preview.woff2?v=${version ?? Date.now()}`,

  // Webfont pratinjau milik SATU project — Beranda merender tiap kartu dalam hurufnya sendiri.
  // Di-cache-bust per updatedAt supaya kartu ikut segar setelah project diedit.
  projectPreviewUrl: (id: string, version?: number) =>
    `${BASE}/projects/${encodeURIComponent(id)}/preview.woff2?v=${version ?? 0}`,
  exportUrl: () => `${BASE}/export`,

  // Ambil arsip font (ZIP) sebagai blob + nama file dari header → dipakai dialog "Simpan sebagai".
  exportBlob: async (): Promise<{ blob: Blob; filename: string }> => {
    const r = await fetch(`${BASE}/export`);
    if (r.status === 401) { onUnauthorized?.(); throw new Error("Perlu login"); }
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    const cd = r.headers.get("Content-Disposition") || "";
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    // decode bisa melempar URIError utk nama polos ber-'%' (mis. 100%Sans) → fallback ke mentah
    let filename = "font.zip";
    if (m) { try { filename = decodeURIComponent(m[1]); } catch { filename = m[1]; } }
    return { blob: await r.blob(), filename };
  },
};
