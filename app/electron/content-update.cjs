// Updater "ISI" (content) — perbarui kode aplikasi (server/engine/UI) TANPA reinstall installer.
//
// Isi dikirim sebagai file di content dir; installer hanya membekukan interpreter + library.
// Modul ini menarik paket isi kecil (~1–2 MB) dari GitHub release tag "content", memvalidasi,
// dan menaruhnya di userData/content-staging. main.cjs menerapkannya (rename → content) saat
// aplikasi dibuka BERIKUTNYA — aman, tanpa swap di tengah sesi.
const { app } = require("electron");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const CONTENT_JSON_URL =
  "https://github.com/sensatype/Sensatype-Font-Tool-App/releases/download/content/content.json";

function cmpSemver(a, b) {
  const norm = (s) => String(s).replace(/^v/i, "").split(/[-+]/)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const x = norm(a), y = norm(b);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return 1; if ((x[i] || 0) < (y[i] || 0)) return -1; }
  return 0;
}

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "SensatypeFontTool" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume(); return httpGet(res.headers.location, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
  });
}

// Cek + (bila ada & kompatibel) unduh & stage update isi. Return {status, ...}.
//   status: "none" | "staged" | "needsApp" | "error"
async function checkContentUpdate({ currentContentVer }) {
  let manifest;
  try {
    manifest = JSON.parse((await httpGet(CONTENT_JSON_URL)).toString("utf8"));
  } catch (e) {
    return { status: "error", error: String(e.message || e) };
  }
  const remote = Number(manifest.content) || 0;
  if (remote <= (Number(currentContentVer) || 0)) return { status: "none" };
  if (manifest.minApp && cmpSemver(manifest.minApp, app.getVersion()) > 0)
    return { status: "needsApp", minApp: manifest.minApp, version: remote };
  if (!manifest.url) return { status: "error", error: "manifest tanpa url" };

  const staging = path.join(app.getPath("userData"), "content-staging");
  try {
    const zip = await httpGet(manifest.url);
    let AdmZip;
    try { AdmZip = require("adm-zip"); } catch (e) { return { status: "error", error: "adm-zip tak ada" }; }
    fs.rmSync(staging, { recursive: true, force: true });
    new AdmZip(zip).extractAllTo(staging, /* overwrite */ true);
    // Validasi: harus ada server/ + dist/ + meta.json dgn versi cocok.
    const meta = JSON.parse(fs.readFileSync(path.join(staging, "meta.json"), "utf8"));
    if (!fs.existsSync(path.join(staging, "server")) || !fs.existsSync(path.join(staging, "dist")) ||
        !fs.existsSync(path.join(staging, "engine")) || Number(meta.content) !== remote) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { status: "error", error: "paket isi tak lengkap/tak cocok" };
    }
    return { status: "staged", version: remote };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { status: "error", error: String(e.message || e) };
  }
}

module.exports = { checkContentUpdate };
