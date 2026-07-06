// Pembaruan di dalam aplikasi untuk Sensatype Font Tool.
//
// Sumber rilis: GitHub Releases (lihat build.publish di package.json).
//
//  - Windows (NSIS): auto-update PENUH via electron-updater — unduh di latar,
//    lalu "Pasang & mulai ulang". Jalan tanpa code-signing (hanya ada peringatan
//    SmartScreen sekali saat pertama pasang).
//  - macOS: Squirrel.Mac MEWAJIBKAN app ber-signature (Developer ID) untuk meng-
//    install pembaruan. Build ini sengaja TANPA signing (internal), jadi di macOS
//    kita tidak auto-install; sebagai gantinya: cek versi terbaru lewat GitHub API,
//    beri tahu, dan buka halaman rilis agar user mengunduh .dmg lalu pasang manual.
//    Aman & andal tanpa sertifikat.
//
// Repo di bawah HARUS sama dengan build.publish (owner/repo) di package.json.
const { app, dialog, shell } = require("electron");
const https = require("node:https");

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

// macOS: cek + beri tahu + buka halaman rilis (tak bisa auto-install tanpa signing).
async function checkMac(manual) {
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
  const r = await dialog.showMessageBox({
    type: "info", buttons: ["Unduh", "Nanti"], defaultId: 0, cancelId: 1,
    message: `Versi baru tersedia: ${latest}`,
    detail: `Anda memakai ${app.getVersion()}. Unduh installer terbaru (.dmg) dari halaman rilis?`,
  });
  if (r.response === 0) {
    shell.openExternal(rel.html_url || `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest`);
  }
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
  autoUpdater.on("update-not-available", () => {
    if (manual) dialog.showMessageBox({ type: "info", message: "Sudah versi terbaru", detail: `Versi ${app.getVersion()}` });
  });
  autoUpdater.on("error", (err) => {
    if (manual) dialog.showMessageBox({ type: "warning", message: "Gagal memeriksa pembaruan", detail: String((err && err.message) || err) });
  });
  autoUpdater.on("update-downloaded", async (info) => {
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
  if (process.platform === "darwin") checkMac(manual);
  else checkWin(manual);
}

module.exports = { checkForUpdates };
