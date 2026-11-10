const { createHash, randomUUID } = require("node:crypto");
const { readFileSync, renameSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const BUILDER_VERSION = "26.15.3";
const ORIGINAL_SHA256 = "80fa75cf8cb68f4999eb92afc9f37f8e5b605cb1c3a077821bbc350a9b907a48";
const PATCHED_SHA256 = "1ff3da2a5e483bc3c6b0060c0f5a31d613e32e548e42706f97d28491a5e7625d";

// electron-builder 26.15.3 always loads its own portable.nsi; portable does not
// support the installer's script/include override. Its useZip path omits the
// ARM64-only branch. Keep the upstream launcher, cleanup, and security behavior,
// adding only that missing direct-extraction branch before packaging begins.
// Upstream: electron-userland/electron-builder, MIT, templates/nsis/portable.nsi.
const ORIGINAL_BRANCH = String.raw`  !else
    !ifdef APP_DIR_32
      File /r "${"${APP_DIR_32}"}\*.*"
    !else
      !insertmacro extractEmbeddedAppPackage
    !endif
  !endif`;
const PATCHED_BRANCH = String.raw`  !else
    !ifdef APP_DIR_ARM64
      File /r "${"${APP_DIR_ARM64}"}\*.*"
    !else
      !ifdef APP_DIR_32
        File /r "${"${APP_DIR_32}"}\*.*"
      !else
        !insertmacro extractEmbeddedAppPackage
      !endif
    !endif
  !endif`;

function patchPortableTemplate(version, source) {
   if (version !== BUILDER_VERSION) {
      throw new Error("Review the Portable ARM64 template workaround before changing app-builder-lib " + version);
   }

   const normalized = source.replace(/\r\n/gu, "\n");
   const digest = sha256(normalized);

   if (digest === PATCHED_SHA256) {
      return normalized;
   }

   if (digest !== ORIGINAL_SHA256) {
      throw new Error("Unexpected Portable template; refusing to patch unreviewed source");
   }

   const patched = normalized.replace(ORIGINAL_BRANCH, PATCHED_BRANCH);

   if (sha256(patched) !== PATCHED_SHA256) {
      throw new Error("Portable ARM64 template patch did not produce the reviewed result");
   }

   return patched;
}

function preparePortable(context) {
   if (context.electronPlatformName !== "win32") {
      return;
   }

   const builderManifestPath = require.resolve("app-builder-lib/package.json");
   const { version } = JSON.parse(readFileSync(builderManifestPath, "utf8"));
   const templatePath = join(dirname(builderManifestPath), "templates", "nsis", "portable.nsi");
   const source = readFileSync(templatePath, "utf8");
   const patched = patchPortableTemplate(version, source);

   if (source === patched) {
      return;
   }

   const temporaryPath = templatePath + "." + randomUUID() + ".tmp";

   try {
      writeFileSync(temporaryPath, patched, {
         encoding: "utf8",
         flag: "wx",
         mode: statSync(templatePath).mode & 0o777
      });
      renameSync(temporaryPath, templatePath);
   } finally {
      rmSync(temporaryPath, { force: true });
   }
}

function sha256(text) {
   return createHash("sha256").update(text).digest("hex");
}

module.exports = preparePortable;
module.exports.patchPortableTemplate = patchPortableTemplate;
module.exports.BUILDER_VERSION = BUILDER_VERSION;
module.exports.ORIGINAL_SHA256 = ORIGINAL_SHA256;
module.exports.PATCHED_SHA256 = PATCHED_SHA256;
