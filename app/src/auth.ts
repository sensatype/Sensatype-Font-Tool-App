// Klien auth aplikasi (sisi UI). Token TIDAK pernah menyentuh browser — backend lokal
// (server/auth.py) yang menyimpannya di keyring & mengintrospeksi. UI hanya memicu login,
// membaca status sesi, dan logout. Saat pindah ke Electron, hanya `start()` (buka browser
// sistem + loopback) yang berubah; sisanya tetap.

const BASE = "/api";

export type Session = {
  authenticated: boolean;
  role?: string | null;
  userId?: string | number | null; // server bisa kirim angka
  name?: string | null;      // nama tampil (dari /verify Sensatype)
  email?: string | null;
  avatarUrl?: string | null; // foto profil (opsional)
  allowed?: boolean; // punya hak masuk Font Tool (fitur #2); false → layar "akses ditolak"
};

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}

export const authApi = {
  start: () => fetch(`${BASE}/auth/start`, { method: "POST" }).then(j<{ loginUrl: string }>),
  callback: (code: string, state: string) =>
    fetch(`${BASE}/auth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    }).then(j<Session>),
  session: () => fetch(`${BASE}/auth/session`).then(j<Session>),
  logout: () => fetch(`${BASE}/auth/logout`, { method: "POST" }).then(j<Session>),
};

// Berjalan di dalam shell Electron? (preload memasang window.sensatype)
export const isElectron =
  typeof window !== "undefined" && !!window.sensatype?.isElectron;

// Buka URL login: Electron → browser sistem (RFC 8252, tak mengintip kredensial);
// browser → navigasi penuh tab yang sama.
export function openLoginUrl(url: string): void {
  if (window.sensatype?.openExternal) void window.sensatype.openExternal(url);
  else window.location.href = url;
}

// Bawa aplikasi Electron ke depan (dipakai setelah login sukses agar app terbuka, bukan web).
export function focusApp(): void {
  window.sensatype?.focus?.();
}

// Peta role → kapabilitas UI. Samakan dgn ADMIN_ROLES di server/auth.py.
export const ADMIN_ROLES = ["admin", "atasan"];
export const can = {
  export: (role?: string | null) => !!role && ADMIN_ROLES.includes(role),
};
