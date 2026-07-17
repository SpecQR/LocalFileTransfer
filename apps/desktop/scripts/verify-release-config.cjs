const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const packagePath = resolve(__dirname, "..", "package.json");
const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
const build = manifest.build ?? {};
const forbiddenKeys = new Set([
   "certificateFile",
   "certificatePassword",
   "certificateSha1",
   "publish"
]);
const found = [];

visit(build, "build");

if (found.length > 0) {
   throw new Error("Release configuration embeds forbidden fields: " + found.join(", "));
}

const targets = build.win?.target;

if (!Array.isArray(targets) || targets.length !== 1 || targets[0] !== "portable") {
   throw new Error("Windows release configuration must target Portable only");
}

if (build.portable?.artifactName !== "Local.File.Transfer-${version}-${arch}-Portable.${ext}") {
   throw new Error("Portable artifacts must include version and architecture");
}

for (const name of ["dist", "dist:arm64", "dist:signed:x64", "dist:signed:arm64"]) {
   if (typeof manifest.scripts?.[name] !== "string") {
      throw new Error("Missing release script: " + name);
   }

   if (!manifest.scripts[name].includes("--publish never")) {
      throw new Error(name + " must disable electron-builder auto-publish");
   }
}

for (const name of ["dist:signed:x64", "dist:signed:arm64"]) {
   if (!manifest.scripts[name].includes("require-signing-env.cjs")) {
      throw new Error(name + " must validate environment-only signing inputs");
   }
}

process.stdout.write(JSON.stringify({
   appId: build.appId,
   productName: build.productName,
   targets,
   portableArtifactName: build.portable.artifactName,
   electronBuilderAutoPublish: false,
   signingCredentialsEmbedded: false,
   updaterConfigured: false
}, null, 3) + "\n");

function visit(value, path) {
   if (!value || typeof value !== "object") {
      return;
   }

   for (const [key, nested] of Object.entries(value)) {
      const nestedPath = path + "." + key;

      if (forbiddenKeys.has(key)) {
         found.push(nestedPath);
      }

      visit(nested, nestedPath);
   }
}
