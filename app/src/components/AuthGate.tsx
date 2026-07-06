import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Loader2, LogIn, ExternalLink, ShieldX } from "lucide-react";
import { authApi, focusApp, isElectron, openLoginUrl, type Session } from "../auth";
import { setUnauthorizedHandler } from "../api";

// Konteks auth untuk komponen di dalam app (mis. TopBar): role + logout.
type AuthCtx = { role?: string | null; userId?: string | null; logout: () => Promise<void> };
const Ctx = createContext<AuthCtx>({ logout: async () => {} });
export const useAuth = () => useContext(Ctx);

type Phase =
  | { k: "loading" }
  | { k: "callback" }
  | { k: "waiting" }   // Electron: login berlangsung di browser sistem, kita polling sesi
  | { k: "anon"; msg?: string }
  | { k: "authed"; s: Session };

// Gerbang auth: menutup seluruh app sampai ada sesi valid. Menangani redirect balik dari
// login Sensatype di route /auth/callback (Vite melayani index.html utk path ini via SPA fallback).
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ k: "loading" });

  const logout = useCallback(async () => {
    try { await authApi.logout(); } catch { /* tetap keluar walau server tak terjangkau */ }
    setPhase({ k: "anon" });
  }, []);

  const beginLogin = useCallback(async () => {
    setPhase({ k: "loading" });
    try {
      const { loginUrl } = await authApi.start();
      if (isElectron) {
        openLoginUrl(loginUrl);      // buka di browser sistem; loopback ke backend, kita polling
        setPhase({ k: "waiting" });
      } else {
        window.location.href = loginUrl; // browser: navigasi penuh, kembali via /auth/callback
      }
    } catch (e) {
      setPhase({ k: "anon", msg: (e as Error).message || String(e) });
    }
  }, []);

  // Mode Electron: sambil user login di browser sistem, tanyakan sesi berkala sampai valid.
  useEffect(() => {
    if (phase.k !== "waiting") return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await authApi.session();
        if (alive && s.authenticated) {
          focusApp();            // login selesai di browser → bawa app ke depan otomatis
          setPhase({ k: "authed", s });
        }
      } catch { /* server belum siap / belum login — coba lagi */ }
    };
    const id = window.setInterval(tick, 1200);
    tick();
    return () => { alive = false; clearInterval(id); };
  }, [phase.k]);

  useEffect(() => {
    // 401 dari request mana pun → balik ke layar login (token dicabut / kedaluwarsa).
    setUnauthorizedHandler(() => setPhase({ k: "anon" }));

    if (window.location.pathname === "/auth/callback") {
      const u = new URL(window.location.href);
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const err = u.searchParams.get("error");
      window.history.replaceState({}, "", "/"); // jangan tinggalkan code di address bar/history
      if (err) { setPhase({ k: "anon", msg: err }); return; }
      if (!code || !state) { setPhase({ k: "anon" }); return; }
      setPhase({ k: "callback" });
      authApi.callback(code, state)
        .then((s) => setPhase(s.authenticated ? { k: "authed", s } : { k: "anon" }))
        .catch((e) => setPhase({ k: "anon", msg: (e as Error).message || String(e) }));
      return;
    }

    authApi.session()
      .then((s) => setPhase(s.authenticated ? { k: "authed", s } : { k: "anon" }))
      .catch(() => setPhase({ k: "anon" }));
  }, []);

  if (phase.k === "loading" || phase.k === "callback")
    return (
      <Screen>
        <Loader2 className="size-6 animate-spin text-muted" />
        <p className="text-muted text-sm">{phase.k === "callback" ? "Menyelesaikan login…" : "Memuat…"}</p>
      </Screen>
    );

  if (phase.k === "waiting")
    return (
      <Screen>
        <Loader2 className="size-6 animate-spin text-muted" />
        <p className="text-muted text-sm max-w-xs text-center">
          Menunggu login di browser… Selesaikan kata sandi + OTP + PIN, lalu jendela ini akan lanjut sendiri.
        </p>
        <div className="flex gap-2">
          <button className="btn" onClick={beginLogin}><ExternalLink className="size-4" /> Buka lagi</button>
          <button className="btn" onClick={() => setPhase({ k: "anon" })}>Batal</button>
        </div>
      </Screen>
    );

  if (phase.k === "authed") {
    // Login sah TAPI akun tak berhak masuk Font Tool (fitur #2) → tolak, sediakan keluar.
    if (phase.s.allowed === false)
      return (
        <Screen>
          <div className="size-12 rounded-2xl grid place-items-center text-white bg-red-500/90">
            <ShieldX className="size-6" />
          </div>
          <h1 className="text-lg font-semibold">Akses ditolak</h1>
          <p className="text-muted text-sm max-w-xs text-center">
            Akun Anda{phase.s.role ? ` (${phase.s.role})` : ""} tidak memiliki hak akses ke Font Tool.
            Hubungi admin bila ini keliru.
          </p>
          <button className="btn" onClick={logout}>Keluar</button>
        </Screen>
      );
    return (
      <Ctx.Provider value={{ role: phase.s.role, userId: phase.s.userId, logout }}>
        {children}
      </Ctx.Provider>
    );
  }

  return (
    <Screen>
      <div className="size-12 rounded-2xl bg-accent grid place-items-center text-white font-bold text-lg">S</div>
      <h1 className="text-lg font-semibold">Sensatype Font Tool</h1>
      <p className="text-muted text-sm max-w-xs text-center">
        Masuk dengan akun Sensatype untuk melanjutkan. Login diverifikasi di server Sensatype
        (kata sandi + OTP email + PIN).
      </p>
      {phase.msg && <p className="text-xs text-red-500 max-w-xs text-center">{phase.msg}</p>}
      <button className="btn btn-accent" onClick={beginLogin}>
        <LogIn className="size-4" /> Masuk dengan Sensatype
      </button>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full grid place-items-center">
      <div className="flex flex-col items-center gap-3">{children}</div>
    </div>
  );
}
