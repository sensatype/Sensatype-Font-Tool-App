// electron-builder afterPack — ad-hoc code-sign bundle macOS.
//
// Di Apple Silicon setiap binary WAJIB bertanda tangan. App tanpa tanda tangan yang diunduh
// (punya atribut karantina) ditolak macOS dengan pesan menyesatkan "…is damaged and can't be
// opened". Ad-hoc signing (identitas "-", gratis, tanpa sertifikat Apple) menaruh tanda tangan
// sehingga pesannya turun menjadi "unidentified developer" — cukup klik-kanan → Open sekali.
// --deep ikut menandatangani backend beku (PyInstaller) + dylib di dalam Resources.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[afterPack] ad-hoc signing: ${appPath}`);
  execFileSync("codesign", ["--deep", "--force", "--sign", "-", appPath], { stdio: "inherit" });
};
