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
const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { checkForUpdates } = require("./updater.cjs");

const BACKEND_PORT = 8000;
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`;
const REPO_ROOT = path.join(__dirname, "..", ".."); // app/electron → root repo (mode dev)
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL || null; // dev: http://localhost:5173

// Server login (Sensatype Project) HARUS di Mac Mini M4, BUKAN MacBook. Aplikasi menembak
// domain publik; arahkan project.sensatype.com → Mac Mini M4 di sisi DNS/reverse-proxy.
// (Override lewat env hanya untuk keperluan uji; jangan set ke alamat MacBook.)
const AUTH_API_BASE = process.env.SENSATYPE_API_BASE || "https://project.sensatype.com/api";
const AUTH_LOGIN_URL = process.env.SENSATYPE_LOGIN_URL || "https://project.sensatype.com/login";

let backendProc = null;
let mainWindow = null;

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
    // Data project HARUS di lokasi yang bisa ditulis (di dalam bundle app = read-only).
    env.SENSATYPE_PROJECTS_DIR = path.join(app.getPath("userData"), "projects");
  } else {
    // Mode dev: pakai uvicorn dari .venv repo.
    cmd = process.platform === "win32"
      ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
      : path.join(REPO_ROOT, ".venv", "bin", "python");
    args = ["-m", "uvicorn", "server.app:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)];
    cwd = REPO_ROOT;
  }

  backendProc = spawn(cmd, args, { cwd, env, stdio: "inherit" });
  backendProc.on("exit", (code) => { console.log("[backend] keluar", code); backendProc = null; });
  return waitFor(`${BACKEND_ORIGIN}/api/health`, 20000);
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
        { label: "Periksa Pembaruan…", click: () => checkForUpdates(true) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1000, minHeight: 640,
    backgroundColor: "#14171d", show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  // Dev: Vite (HMR). Prod: SPA dilayani backend (same-origin dgn /api).
  mainWindow.loadURL(RENDERER_URL || BACKEND_ORIGIN);
  // Semua link http(s) → browser sistem; tak ada jendela app baru.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Cegah renderer bernavigasi keluar dari UI-nya sendiri (anti-hijack).
  mainWindow.webContents.on("will-navigate", (e, url) => {
    const base = RENDERER_URL || BACKEND_ORIGIN;
    if (!url.startsWith(base)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
}

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
  app.whenReady().then(async () => {
    buildMenu();
    if (!(await ensureBackend())) console.error("[backend] gagal start dalam 20s");
    createWindow();
    // Auto-cek pembaruan sekali setelah UI siap (senyap bila sudah terbaru / tak terpasang).
    setTimeout(() => checkForUpdates(false), 4000);
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { if (backendProc) backendProc.kill(); });
