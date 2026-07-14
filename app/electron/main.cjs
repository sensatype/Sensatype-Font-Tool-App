// Electron main — shell tipis untuk Sensatype Font Tool.
//
// Prinsip (RFC 8252 + pengerasan Electron):
//  - Login dibuka di BROWSER SISTEM (shell.openExternal), TAK PERNAH webview embedded
//    → app tak bisa mengintip kata sandi/OTP/PIN.
//  - Token TIDAK disimpan di sini; backend Python (uvicorn) menyimpannya di OS keyring.
//    Main process hanya membuka browser & memuat UI.
//  - Renderer terisolasi: contextIsolation ON, nodeIntegration OFF, sandbox ON.
//  - Callback login = loopback GET /api/auth/callback yang dilayani uvicorn (same-origin
//    dgn UI di mode prod → tanpa isu CORS/CSRF).
const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { checkForUpdates } = require("./updater.cjs");

// Jaring pengaman: error latar (mis. updater) TAK BOLEH memunculkan dialog crash Electron
// atau mematikan aplikasi. Cukup catat — app tetap jalan.
process.on("uncaughtException", (e) => { console.error("[uncaughtException]", e); });
process.on("unhandledRejection", (e) => { console.error("[unhandledRejection]", e); });

const BACKEND_PORT = 8000;
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`;
const REPO_ROOT = path.join(__dirname, "..", ".."); // app/electron → root repo (mode dev)
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL || null; // dev: http://localhost:5173

// Server login (Sensatype Project) HARUS di Mac Mini M4, BUKAN MacBook. Aplikasi menembak
// domain publik; arahkan project.sensatype.com → Mac Mini M4 di sisi DNS/reverse-proxy.
// (Override lewat env hanya untuk keperluan uji; jangan set ke alamat MacBook.)
const AUTH_API_BASE = process.env.SENSATYPE_API_BASE || "https://project.sensatype.com/api";
const AUTH_LOGIN_URL = process.env.SENSATYPE_LOGIN_URL || "https://project.sensatype.com/login";

// URL aplikasi (dev: Vite · prod: SPA dilayani backend). Halaman "Memuat…"/error =
// data URL yang SELALU tampil sebelum backend siap → jendela tak pernah blank ("kosong").
const APP_URL = RENDERER_URL || BACKEND_ORIGIN;
const LOADING_PAGE = "data:text/html;charset=utf-8," + encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#14171d;color:#8b93a1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">`
  + `<div style="width:34px;height:34px;border:3px solid #2a2f3a;border-top-color:#4f8cff;border-radius:50%;animation:s .8s linear infinite"></div>`
  + `<div style="font-size:13px">Memuat Sensatype Font Tool…</div><style>@keyframes s{to{transform:rotate(360deg)}}</style></body>`);
const ERROR_PAGE = "data:text/html;charset=utf-8," + encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:#14171d;color:#e6e8ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;padding:0 30px">`
  + `<div style="font-size:15px;font-weight:600">Gagal memulai mesin font</div>`
  + `<div style="font-size:13px;color:#8b93a1;max-width:420px">Backend lokal tak merespons. Tutup lalu buka lagi aplikasi. Jika terus terjadi, pasang ulang versi terbaru.</div></body>`);

let backendProc = null;
let mainWindow = null;
let effectiveContentDir = null; // folder "isi" aktif (server/engine/dist) — baseline atau overlay
let effectiveContentVer = 0;

// Versi isi dari meta.json sebuah content dir (-1 = tak ada/invalid).
function contentVer(dir) {
  try { return Number(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")).content) || 0; }
  catch { return -1; }
}

// Tentukan content dir aktif (mode terpasang):
//  1) Terapkan hasil "update isi" sesi lalu: userData/content-staging → userData/content.
//  2) Pilih versi TERTINGGI antara baseline installer (resources/content) & overlay (userData/content).
//     → installer baru otomatis menggantikan overlay lama; update isi dipakai sampai installer baru.
function resolveContentDir() {
  const baseline = path.join(process.resourcesPath, "content");
  const overlay = path.join(app.getPath("userData"), "content");
  const staging = path.join(app.getPath("userData"), "content-staging");
  if (fs.existsSync(path.join(staging, "meta.json"))) {
    // Swap AMAN: sisihkan overlay lama ke .old DULU, pasang staging, baru buang .old. JANGAN
    // hapus overlay hidup sebelum staging benar-benar terpasang — kalau rename gagal di tengah,
    // overlay lama masih bisa dipulihkan (hindari regresi diam-diam ke baseline lama + loop unduh).
    const old = overlay + ".old";
    try {
      fs.rmSync(old, { recursive: true, force: true });
      if (fs.existsSync(overlay)) fs.renameSync(overlay, old);   // overlay lama → .old
      fs.renameSync(staging, overlay);                            // staging → overlay
      fs.rmSync(old, { recursive: true, force: true });          // sukses → buang yang lama
    } catch (e) {
      console.error("[content] gagal terapkan staging", e);
      try { if (!fs.existsSync(overlay) && fs.existsSync(old)) fs.renameSync(old, overlay); } catch { /* ok */ } // pulihkan
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ok */ }
      try { fs.rmSync(old, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }
  const bV = contentVer(baseline), oV = contentVer(overlay);
  const dir = (oV > bV) ? overlay : baseline;
  effectiveContentDir = dir;
  effectiveContentVer = Math.max(bV, oV, 0);
  return dir;
}

// Cek + stage "update isi" (ringan). Return status: none|staged|needsApp|error.
async function checkContent(manual = false) {
  if (!app.isPackaged) { if (manual) dialog.showMessageBox({ type: "info", message: "Mode pengembangan", detail: "Update isi hanya di aplikasi terpasang." }); return "none"; }
  try {
    const { checkContentUpdate } = require("./content-update.cjs");
    const r = await checkContentUpdate({ currentContentVer: effectiveContentVer });
    if (manual && r.status === "none") {
      dialog.showMessageBox({ type: "info", message: "Isi sudah terbaru", detail: `Versi isi ${effectiveContentVer}.` });
    }
    if (manual && r.status === "needsApp") {
      // JANGAN bilang "sudah terbaru" — ada isi baru yang butuh aplikasi lebih baru. Beri tahu jujur;
      // pemanggil akan lanjut ke cek installer penuh (checkForUpdates) karena status ≠ "staged".
      dialog.showMessageBox({ type: "info", message: "Perlu perbarui aplikasi", detail: `Ada pembaruan isi (v${r.version}) yang butuh aplikasi ≥ ${r.minApp}. Aplikasi akan memeriksa pembaruan installer.` });
    }
    if (r.status === "staged") {
      // Tawarkan RESTART sekarang → menerapkan update seketika (menghindari jebakan macOS:
      // menutup jendela ≠ keluar app, jadi update tak pernah diterapkan). Restart = whenReady
      // jalan lagi → resolveContentDir menukar staging → content baru aktif.
      const resp = await dialog.showMessageBox({
        type: "info", buttons: ["Mulai ulang sekarang", "Nanti"], defaultId: 0, cancelId: 1,
        message: "Pembaruan siap dipasang",
        detail: "Perbaikan & fitur terbaru sudah diunduh. Mulai ulang aplikasi untuk menerapkannya?",
      });
      if (resp.response === 0) restartToApply();
    }
    return r.status;
  } catch (e) { console.error("[content]", e); return "error"; }
}

// Mulai ulang utk MENERAPKAN isi ter-stage. Bunuh backend lalu TUNGGU port benar-benar bebas
// sebelum relaunch — kalau tidak, instance baru bisa memakai backend lama (yang masih meng-import
// server versi lama) → swap seolah tak berefek (isi baru "tak muncul"). Ref: jebakan macOS.
async function restartToApply() {
  try {
    const proc = backendProc;
    if (proc) {
      await new Promise((res) => {
        let done = false; const fin = () => { if (!done) { done = true; res(); } };
        proc.once("exit", fin);
        try { proc.kill("SIGTERM"); } catch { /* sudah mati */ }
        setTimeout(fin, 4000); // jangan menggantung
      });
    }
    for (let i = 0; i < 20 && await ping(`${BACKEND_ORIGIN}/api/health`); i++) {
      await new Promise((r) => setTimeout(r, 200)); // tunggu port lepas (maks ~4s)
    }
  } catch (e) { console.error("[content] restartToApply", e); }
  app.relaunch(); app.quit();
}

// Cek pembaruan (isi + installer) dengan pengaman: satu cek sekali jalan, dan utk cek OTOMATIS
// paling sering sekali per 30 menit. Dipanggil saat start, berkala (setInterval), & saat activate —
// supaya app macOS yang jarang di-Cmd+Q (jendela ditutup ≠ keluar) tetap dapat pembaruan.
let _lastUpdateCheck = 0;
let _updateChecking = false;
async function runUpdateChecks(manual = false) {
  if (_updateChecking) return;
  const now = Date.now();
  if (!manual && now - _lastUpdateCheck < 30 * 60 * 1000) return;
  _updateChecking = true; _lastUpdateCheck = now;
  try {
    const st = await checkContent(manual);       // dahulukan update isi (ringan)
    if (st !== "staged") checkForUpdates(manual); // tak ada isi baru / butuh installer → cek installer
  } catch (e) { console.error("[update] runUpdateChecks", e); }
  finally { _updateChecking = false; }
}

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping(url)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function ensureBackend() {
  // Bila backend sudah jalan (mis. uvicorn dev), pakai itu — jangan bentrok port.
  if (await ping(`${BACKEND_ORIGIN}/api/health`)) return true;

  const env = {
    ...process.env,
    // Loopback RFC 8252 — server Sensatype WAJIB allowlist URI ini.
    SENSATYPE_REDIRECT_URI: `${BACKEND_ORIGIN}/api/auth/callback`,
    // Login SELALU ke Mac Mini M4 via domain publik (deterministik, tak ikut env MacBook).
    SENSATYPE_API_BASE: AUTH_API_BASE,
    SENSATYPE_LOGIN_URL: AUTH_LOGIN_URL,
  };

  let cmd, args, cwd;
  if (app.isPackaged) {
    // Aplikasi terpasang: backend Python beku (PyInstaller) dikirim di resources/backend/.
    const bin = process.platform === "win32" ? "sensatype-backend.exe" : "sensatype-backend";
    cmd = path.join(process.resourcesPath, "backend", bin);
    args = ["--host", "127.0.0.1", "--port", String(BACKEND_PORT)];
    cwd = process.resourcesPath;
    // "Isi" (server+engine+dist) dimuat dari content dir aktif → bisa di-update tanpa reinstall.
    // Sudah di-resolve di whenReady (menerapkan staging walau backend lama masih hidup); pakai itu.
    const cdir = effectiveContentDir || resolveContentDir();
    env.SENSATYPE_CONTENT_DIR = cdir;          // run_backend menaruhnya di sys.path → import server dari sini
    env.SENSATYPE_ENGINE_DIR = path.join(cdir, "engine");
    env.SENSATYPE_DIST_DIR = path.join(cdir, "dist");
    // Data yang bisa berubah HARUS di lokasi writable (di dalam bundle app = read-only).
    env.SENSATYPE_PROJECTS_DIR = path.join(app.getPath("userData"), "projects");
    env.SENSATYPE_LEGACY_WORKSPACE = path.join(app.getPath("userData"), "workspace");
    // macOS: bila app dipasang lewat drag (bukan skrip), backend beku bisa MASIH terkarantina →
    // macOS memblokir eksekusinya → backend tak start → jendela "kosong". Lepas karantina dulu
    // (best-effort) agar helper bisa dijalankan. Aman & idempotent.
    if (process.platform === "darwin") {
      try {
        require("node:child_process").execFileSync(
          "xattr", ["-dr", "com.apple.quarantine", path.join(process.resourcesPath, "backend")],
          { stdio: "ignore", timeout: 5000 });
      } catch { /* sudah bersih / tak ada xattr — abaikan */ }
    }
  } else {
    // Mode dev: pakai uvicorn dari .venv repo.
    cmd = process.platform === "win32"
      ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
      : path.join(REPO_ROOT, ".venv", "bin", "python");
    args = ["-m", "uvicorn", "server.app:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)];
    cwd = REPO_ROOT;
  }

  backendProc = spawn(cmd, args, {
    cwd,
    env,
    // Terpasang: buang stdio (tak ada konsol untuk ditulisi). Dev: warisi (lihat log di terminal).
    stdio: app.isPackaged ? "ignore" : "inherit",
    // Windows: cegah jendela terminal muncul saat menjalankan backend beku (CREATE_NO_WINDOW).
    windowsHide: true,
  });
  backendProc.on("exit", (code) => { console.log("[backend] keluar", code); backendProc = null; });
  // Terpasang: cold-start backend beku bisa lama (scan Gatekeeper first-run) → beri waktu lebih.
  return waitFor(`${BACKEND_ORIGIN}/api/health`, app.isPackaged ? 60000 : 20000);
}

// Menu aplikasi — sertakan "Periksa Pembaruan…" (manual) selain standar edit/view/window.
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      label: "Bantuan",
      submenu: [
        { label: "Periksa Pembaruan…", click: () => runUpdateChecks(true) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Ukuran/posisi jendela diingat antar-sesi (quit → buka lagi = ukuran terakhir).
const boundsFile = () => path.join(app.getPath("userData"), "window-bounds.json");
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(boundsFile(), "utf8")); } catch { return null; }
}
function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify({ ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() }));
  } catch { /* disk penuh dsb — abaikan */ }
}

function createWindow() {
  const saved = loadBounds();
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1400, height: saved?.height ?? 900,
    ...(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1000, minHeight: 640,
    backgroundColor: "#14171d", show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (saved?.maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", saveBounds); // simpan ukuran terakhir saat ditutup
  // Tampilkan "Memuat…" DULU (bukan langsung app) → jendela tak pernah blank sementara backend start.
  mainWindow.loadURL(LOADING_PAGE);
  // Bila app URL sudah dimuat lalu gagal (backend hiccup) → coba muat ulang.
  mainWindow.webContents.on("did-fail-load", (_e, _code, _desc, url, isMainFrame) => {
    if (isMainFrame && url && url.startsWith(APP_URL) && mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(APP_URL); }, 900);
    }
  });
  // Semua link http(s) → browser sistem; tak ada jendela app baru.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Cegah renderer bernavigasi keluar dari UI-nya sendiri (anti-hijack).
  // Bandingkan ORIGIN via new URL — prefix string bisa dikelabui (mis. http://127.0.0.1:8000.evil.com).
  mainWindow.webContents.on("will-navigate", (e, url) => {
    let ok = false;
    try { ok = new URL(url).origin === new URL(APP_URL).origin; } catch { /* url tak valid */ }
    if (!ok) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  startAppLoad();
}

// Poll kesehatan backend lalu muat aplikasi. Sebelum backend sehat, jendela tetap di
// halaman "Memuat…" (tak pernah blank). Setelah ~2 menit tanpa respons → halaman error.
function startAppLoad(attempt = 0) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  ping(`${BACKEND_ORIGIN}/api/health`).then((ok) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (ok) mainWindow.loadURL(APP_URL);
    else if (attempt < 170) setTimeout(() => startAppLoad(attempt + 1), 700);
    else mainWindow.loadURL(ERROR_PAGE);
  });
}

// Bawa jendela app ke depan (dipanggil renderer saat login selesai) — user tak perlu
// pindah manual dari browser ke app; app "terbuka sendiri".
ipcMain.handle("sensatype:focus", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  try { app.focus({ steal: true }); } catch { /* steal hanya di macOS */ }
  return true;
});

// Buka URL login di browser sistem (dipanggil renderer via preload). Hanya http(s).
ipcMain.handle("sensatype:open-external", (_e, url) => {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") return shell.openExternal(url);
  } catch { /* url tak valid */ }
  return false;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    buildMenu();
    // Terapkan isi ter-stage & tetapkan versi isi TANPA syarat di sini — ensureBackend bisa
    // early-return (backend lama masih hidup) & tak pernah memanggil resolveContentDir → dulu
    // update-isi ter-stage tak pernah aktif + effectiveContentVer mentok 0 (loop unduh).
    if (app.isPackaged) resolveContentDir();
    ensureBackend();   // spawn backend (tak diblok — createWindow menampilkan "Memuat…", startAppLoad menunggu health)
    createWindow();
    // Auto-cek pembaruan setelah UI siap, lalu BERKALA. Tanpa yang berkala, di macOS (tutup jendela
    // ≠ keluar app) cek cuma jalan sekali seumur proses → user "nyangkut" di versi lama selamanya.
    setTimeout(() => runUpdateChecks(false), 5000);
    setInterval(() => runUpdateChecks(false), 3 * 60 * 60 * 1000); // tiap 3 jam (dijaga min-interval 30 mnt)
    // macOS: buka lagi jendela lewat Dock → cek pembaruan lagi (dijaga min-interval, tak spam).
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); runUpdateChecks(false); });
  });
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { if (backendProc) backendProc.kill(); });
