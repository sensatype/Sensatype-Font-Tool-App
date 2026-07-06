// Pembaruan di dalam aplikasi untuk Sensatype Font Tool.
//
// Sumber rilis: GitHub Releases (lihat build.publish di package.json).
//
//  - Windows (NSIS): auto-update PENUH via electron-updater — unduh di latar,
//    lalu "Pasang & mulai ulang". Jalan tanpa code-signing.
//  - macOS: Squirrel.Mac (electron-updater) mewajibkan Developer ID + notarization,
//    yang sengaja TIDAK kita pakai. Sebagai gantinya updater KUSTOM di sini:
//    unduh .dmg sendiri (bukan lewat browser) → pasang (ganti bundle + hapus atribut
//    karantina) → restart otomatis. Karena app yang mengunduh (bukan browser), berkas
//    tak berkarantina, jadi Gatekeeper tak menghadang saat relaunch. (Instalasi PERTAMA
//    dari unduhan browser tetap perlu "Open Anyway" sekali — batas tanpa notarization.)
//
// Repo di bawah HARUS sama dengan build.publish (owner/repo) di package.json.
const { app, dialog, shell, Notification, BrowserWindow } = require("electron");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO = { owner: "sensatype", repo: "Sensatype-Font-Tool-App" }; // samakan dgn build.publish

// Bandingkan versi semver (x.y.z). Toleran prefix 'v'; pre-release/build diabaikan.
function cmpSemver(a, b) {
  const norm = (s) => String(s).replace(/^v/i, "").split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const x = norm(a), y = norm(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) > (y[i] || 0)) return 1;
    if ((x[i] || 0) < (y[i] || 0)) return -1;
  }
  return 0;
}

function ghLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: "api.github.com",
        path: `/repos/${REPO.owner}/${REPO.repo}/releases/latest`,
        headers: { "User-Agent": "SensatypeFontTool", Accept: "application/vnd.github+json" },
      },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub HTTP ${res.statusCode}`)); }
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      },
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("timeout menghubungi GitHub")));
  });
}

// Unduh (ikuti redirect GitHub→S3), tulis ke `dest`, laporkan progres ke bar Dock.
function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "SensatypeFontTool" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        return download(res.headers.location, dest, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`unduh HTTP ${res.statusCode}`)); }
      const total = parseInt(res.headers["content-length"] || "0", 10);
      let got = 0;
      const file = fs.createWriteStream(dest);
      res.on("data", (d) => { got += d.length; if (total && onProgress) onProgress(got / total); });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(dest)));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // kutip aman utk /bin/bash

// ── Pop-up progres unduhan (persentase) ────────────────────────────────────────
let progressWin = null;
function showProgress(label) {
  closeProgress();
  progressWin = new BrowserWindow({
    width: 400, height: 150, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, title: "Pembaruan",
    backgroundColor: "#14171d", webPreferences: { contextIsolation: true, sandbox: false },
  });
  progressWin.setMenuBarVisibility(false);
  const safe = String(label).replace(/[<&]/g, "");
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#14171d;color:#e6e8ec;display:flex;flex-direction:column;justify-content:center;padding:20px 22px;gap:12px;user-select:none">
<div style="font-size:13px;font-weight:500">${safe}</div>
<div style="height:8px;background:#2a2f3a;border-radius:99px;overflow:hidden"><div id="bar" style="height:100%;width:0%;background:#4f8cff;transition:width .15s"></div></div>
<div id="pct" style="font-size:12px;color:#8b93a1;text-align:right">0%</div>
<script>window.setPct=function(p){var v=Math.max(0,Math.min(100,Math.round(p)));document.getElementById('bar').style.width=v+'%';document.getElementById('pct').textContent=v+'%';};</script>
</body>`;
  progressWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  progressWin.on("closed", () => { progressWin = null; });
}
function setProgress(pct) {
  if (progressWin && !progressWin.isDestroyed()) {
    progressWin.webContents.executeJavaScript(`window.setPct&&window.setPct(${Number(pct) || 0})`).catch(() => {});
  }
}
function closeProgress() {
  if (progressWin && !progressWin.isDestroyed()) { try { progressWin.close(); } catch { /* ok */ } }
  progressWin = null;
}

// macOS: unduh .dmg sendiri → pasang → restart. Tanpa browser, tanpa pilih file.
async function macUpdate(manual) {
  let rel;
  try {
    rel = await ghLatestRelease();
  } catch (e) {
    if (manual) dialog.showMessageBox({ type: "warning", message: "Gagal memeriksa pembaruan", detail: String(e.message || e) });
    return;
  }
  const latest = rel.tag_name || rel.name || "0.0.0";
  if (cmpSemver(latest, app.getVersion()) <= 0) {
    if (manual) dialog.showMessageBox({ type: "info", message: "Sudah versi terbaru", detail: `Versi ${app.getVersion()}` });
    return;
  }

  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const assets = rel.assets || [];
  const asset = assets.find((a) => a.name.endsWith(`${arch}.dmg`)) || assets.find((a) => a.name.endsWith(".dmg"));
  const exe = process.execPath;                                  // …/Nama.app/Contents/MacOS/Nama
  const appBundle = exe.slice(0, exe.indexOf(".app") + 4);       // …/Nama.app
  let writable = false;
  try { fs.accessSync(path.dirname(appBundle), fs.constants.W_OK); writable = appBundle.endsWith(".app"); } catch { /* tak bisa tulis */ }

  // Tak bisa pasang otomatis (aset .dmg tak ada / lokasi read-only) → jatuh ke unduh manual.
  if (!asset || !writable) {
    const r = await dialog.showMessageBox({
      type: "info", buttons: ["Buka halaman rilis", "Nanti"], defaultId: 0, cancelId: 1,
      message: `Versi baru tersedia: ${latest}`,
      detail: "Tak bisa memasang otomatis di lokasi ini — buka halaman rilis untuk unduh manual?",
    });
    if (r.response === 0) shell.openExternal(rel.html_url || `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest`);
    return;
  }

  const r = await dialog.showMessageBox({
    type: "info", buttons: ["Unduh & pasang", "Nanti"], defaultId: 0, cancelId: 1,
    message: `Versi baru tersedia: ${latest}`,
    detail: "Aplikasi akan mengunduh & memasang pembaruan, lalu memulai ulang otomatis (±1–2 menit).",
  });
  if (r.response !== 0) return;

  const win = BrowserWindow.getAllWindows()[0] || null;
  showProgress(`Mengunduh pembaruan ${latest}…`);
  const dmgPath = path.join(os.tmpdir(), `sensatype-update-${latest}.dmg`);
  try {
    await download(asset.browser_download_url, dmgPath, (f) => { setProgress(f * 100); if (win) win.setProgressBar(f); });
  } catch (e) {
    closeProgress();
    if (win) win.setProgressBar(-1);
    dialog.showMessageBox({ type: "warning", message: "Unduh pembaruan gagal", detail: String(e.message || e) });
    return;
  }
  closeProgress();
  if (win) win.setProgressBar(-1);

  // Skrip installer: tunggu app keluar → mount → ganti bundle → hapus karantina → relaunch.
  const script = `#!/bin/bash
DMG=${shq(dmgPath)}
APP=${shq(appBundle)}
PID=${process.pid}
for i in $(seq 1 200); do kill -0 "$PID" 2>/dev/null || break; sleep 0.3; done
MNT=$(mktemp -d /tmp/sensatype-mnt.XXXXXX)
hdiutil attach "$DMG" -nobrowse -noverify -mountpoint "$MNT" >/dev/null 2>&1
SRC=$(ls -d "$MNT"/*.app 2>/dev/null | head -1)
if [ -n "$SRC" ]; then
  rm -rf "$APP"
  /usr/bin/ditto "$SRC" "$APP"
  /usr/bin/xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
fi
hdiutil detach "$MNT" >/dev/null 2>&1 || true
rm -f "$DMG"
open "$APP"
rm -f "$0"
`;
  const scriptPath = path.join(os.tmpdir(), `sensatype-update-${latest}.sh`);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" }).unref();
  app.quit(); // keluar → skrip mengganti bundle lalu membukanya kembali
}

// Windows: auto-update penuh via electron-updater.
function checkWin(manual) {
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (e) {
    if (manual) dialog.showMessageBox({ type: "warning", message: "Modul pembaruan tak tersedia", detail: String(e.message || e) });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.removeAllListeners();
  const win = BrowserWindow.getAllWindows()[0] || null;
  // Beri tahu + tampilkan pop-up persentase saat versi baru mulai diunduh.
  autoUpdater.on("update-available", (info) => {
    try { new Notification({ title: "Sensatype Font Tool", body: `Versi baru ${info.version} — mengunduh…` }).show(); } catch { /* ok */ }
    showProgress(`Mengunduh pembaruan ${info.version}…`);
  });
  autoUpdater.on("download-progress", (p) => { const pct = p.percent || 0; setProgress(pct); if (win) win.setProgressBar(pct / 100); });
  autoUpdater.on("update-not-available", () => {
    if (manual) dialog.showMessageBox({ type: "info", message: "Sudah versi terbaru", detail: `Versi ${app.getVersion()}` });
  });
  autoUpdater.on("error", (err) => {
    closeProgress();
    if (win) win.setProgressBar(-1);
    if (manual) dialog.showMessageBox({ type: "warning", message: "Gagal memeriksa pembaruan", detail: String((err && err.message) || err) });
  });
  autoUpdater.on("update-downloaded", async (info) => {
    closeProgress();
    if (win) win.setProgressBar(-1);
    const r = await dialog.showMessageBox({
      type: "info", buttons: ["Pasang & mulai ulang", "Nanti"], defaultId: 0, cancelId: 1,
      message: `Pembaruan ${info.version} siap dipasang`,
      detail: "Aplikasi akan ditutup sebentar untuk memasang versi baru.",
    });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.checkForUpdates().catch((e) => { if (manual) console.error("[update]", e); });
}

// Titik masuk. manual=true → dari menu (tampilkan hasil walau tak ada update).
function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox({ type: "info", message: "Mode pengembangan", detail: "Pembaruan otomatis hanya aktif pada aplikasi yang sudah dipasang." });
    return;
  }
  if (process.platform === "darwin") macUpdate(manual);
  else checkWin(manual);
}

module.exports = { checkForUpdates };
