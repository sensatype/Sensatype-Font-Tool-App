// Peta-tombol (keymap) TERPUSAT — satu sumber untuk semua pintasan editor. Bisa diubah pengguna &
// tersimpan per-perangkat (localStorage, sesuai model "device masing-masing"). "Mod" = ⌘ di macOS /
// Ctrl di Windows-Linux, jadi SATU binding berlaku di dua OS. Handler editor MEMBACA keymap ini
// (via commandFor/comboFromEvent), bukan mengecek tombol hardcode.
import { useSyncExternalStore } from "react";

export type CmdContext = "global" | "element" | "contour" | "clean" | "map"; // clean/map = impor langkah 2/3
export interface Command {
  id: string;
  label: string;
  category: string;
  contexts: CmdContext[]; // di mode mana perintah ini berlaku ("global" = di mana saja)
  def: string;            // binding default (kombinasi kanonik, mis. "Mod+Shift+G")
}

// Daftar perintah yang bisa diubah. Panah (nudge) & modifier-saat-seret (Shift/Alt) SENGAJA tak
// di sini — itu interaksi modal/konvensi, bukan "perintah" (Illustrator pun tak mengizinkannya diubah).
export const COMMANDS: Command[] = [
  { id: "undo",      label: "Urungkan",    category: "Umum",   contexts: ["global"],                       def: "Mod+Z" },
  { id: "redo",      label: "Ulangi",      category: "Umum",   contexts: ["global"],                       def: "Mod+Shift+Z" },
  // "Hapus/Buang" & "Pilih semua" berlaku lintas area (editor + impor langkah 2) — SATU command, satu
  // binding, banyak konteks (bukan duplikat) → tak pernah bentrok dgn dirinya.
  { id: "delete",    label: "Hapus / Buang", category: "Umum", contexts: ["element", "contour", "clean"], def: "Delete" },
  { id: "selectAll", label: "Pilih semua", category: "Umum",   contexts: ["element", "clean"],             def: "Mod+A" },
  { id: "duplicate", label: "Duplikat",    category: "Editor", contexts: ["element"],                      def: "Mod+D" },
  { id: "group",     label: "Grup",        category: "Editor", contexts: ["element"],                      def: "Mod+G" },
  { id: "ungroup",   label: "Lepas grup",  category: "Editor", contexts: ["element"],                      def: "Mod+Shift+G" },
  // Impor langkah 2 (Bersihkan) & 3 (Petakan). "Gabung/Pisah" pakai ⌘G/⌘⇧G — mental model "gabung/pisah"
  // yang SAMA dgn editor; aman karena berbeda konteks (deteksi bentrok sadar-konteks).
  { id: "importMerge",  label: "Gabung objek", category: "Impor · Bersihkan", contexts: ["clean"], def: "Mod+G" },
  { id: "importSplit",  label: "Pisah objek",  category: "Impor · Bersihkan", contexts: ["clean"], def: "Mod+Shift+G" },
  { id: "importCommit", label: "Impor font",   category: "Impor · Petakan",   contexts: ["map"],   def: "Mod+Enter" },
];
const BY_ID: Record<string, Command> = Object.fromEntries(COMMANDS.map((c) => [c.id, c]));

export const isMac =
  (typeof window !== "undefined" && window.sensatype?.platform === "darwin") ||
  (typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent));

// ── penyimpanan override (per-perangkat) ───────────────────────────────────────
const LS_KEY = "ge.keymap.v1";
function load(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch { return {}; }
}
let overrides: Record<string, string> = load();
let version = 0;
const listeners = new Set<() => void>();
function commit() {
  version++;
  try { localStorage.setItem(LS_KEY, JSON.stringify(overrides)); } catch { /* disk penuh — abaikan */ }
  listeners.forEach((l) => l());
}

export function bindingOf(id: string): string { return overrides[id] ?? BY_ID[id]?.def ?? ""; }
export function isOverridden(id: string): boolean { return id in overrides; }
export function setBinding(id: string, combo: string) { overrides = { ...overrides, [id]: combo }; commit(); }
export function resetBinding(id: string) { const o = { ...overrides }; delete o[id]; overrides = o; commit(); }
export function resetAll() { overrides = {}; commit(); }

// Perintah yang cocok dengan kombinasi `combo` (opsional dibatasi konteks aktif). null = tak ada.
// Binding kosong ("", hasil "timpa" saat bentrok) tak pernah cocok.
export function commandFor(combo: string, ctx?: CmdContext): Command | null {
  if (!combo) return null;
  for (const c of COMMANDS) {
    if (bindingOf(c.id) !== combo) continue;
    if (ctx && !c.contexts.includes("global") && !c.contexts.includes(ctx)) continue;
    return c;
  }
  return null;
}
// Perintah LAIN yang bentrok dengan `combo` (deteksi bentrok SADAR-KONTEKS), kecuali exceptId.
// Dua perintah hanya BENTROK bila kombinasinya sama DAN konteksnya beririsan (atau salah satu
// "global" → berlaku di semua konteks). → ⌘G boleh "Grup" (editor) & "Gabung objek" (impor)
// sekaligus karena element ∩ clean = ∅. null = bebas.
function ctxOverlap(a: CmdContext[], b: CmdContext[]): boolean {
  return a.includes("global") || b.includes("global") || a.some((c) => b.includes(c));
}
export function conflictFor(combo: string, exceptId: string): Command | null {
  const x = BY_ID[exceptId];
  for (const c of COMMANDS) {
    if (c.id === exceptId) continue;
    if (bindingOf(c.id) !== combo) continue;
    if (!x || ctxOverlap(x.contexts, c.contexts)) return c;
  }
  return null;
}

// ── normalisasi tombol ──────────────────────────────────────────────────────────
const MOD_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);
function normKey(k: string): string {
  if (k === "Backspace") return "Delete"; // Backspace ≡ Delete (konvensi editor; tak dibedakan)
  if (k === " ") return "Space";
  if (k.length === 1) return k.toUpperCase();
  return k; // "Delete", "Enter", "Escape", "ArrowLeft", "F5", …
}
// KeyboardEvent → kombinasi kanonik. "" bila hanya tombol modifier ditekan. Urutan tetap: Mod, Alt, Shift.
export function comboFromEvent(e: KeyboardEvent): string {
  if (MOD_KEYS.has(e.key)) return "";
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(normKey(e.key));
  return parts.join("+");
}
// Tombol khusus yang boleh jadi pintasan tanpa Mod (hindari footgun tombol cetak polos).
const LONE_OK = new Set(["Delete", "Enter", "Escape", "Space", "Tab", "Home", "End", "PageUp", "PageDown",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);
export function isValidCombo(combo: string): boolean {
  if (!combo) return false;
  const parts = combo.split("+");
  return parts.includes("Mod") || LONE_OK.has(parts[parts.length - 1]);
}
// Tampilan untuk platform: "⌘⇧G" (mac) / "Ctrl+Shift+G" (win).
export function formatCombo(combo: string): string {
  if (!combo) return "—";
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const disp = (m: string) =>
    m === "Mod" ? (isMac ? "⌘" : "Ctrl") :
    m === "Shift" ? (isMac ? "⇧" : "Shift") :
    m === "Alt" ? (isMac ? "⌥" : "Alt") : m;
  return [...parts.slice(0, -1).map(disp), key].join(isMac ? "" : "+");
}

// Hook: paksa render-ulang saat keymap berubah (dipakai dialog Pengaturan).
export function useKeymapVersion(): number {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => version,
    () => version,
  );
}
