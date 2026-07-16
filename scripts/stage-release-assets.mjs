import { execFileSync } from "node:child_process";
import {
   access,
   copyFile,
   mkdir,
   readFile,
   readdir,
   rm,
   writeFile
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
   assertReleaseIdentity,
   createBuildProvenance,
   createChecksumDocument,
   createManifestEntries,
   expectedArtifactNames,
   releaseEvidenceFiles,
   sha256
} from "./release-assets-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = await readJson(join(root, "package.json"));
const version = rootManifest.version;
const tag = process.env.LFT_RELEASE_TAG
   ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined)
   ?? "v" + version;
const outputDir = join(root, "release-assets", assertReleaseIdentity(version, tag));
const finalizeOnly = process.argv.includes("--finalize");

assertGeneratedDirectory(outputDir);

if (!finalizeOnly) {
   await stageBaseAssets();
}

const summary = await finalizeAssets();

process.stdout.write(JSON.stringify({
   version,
   tag,
   outputDirectory: normalize(relative(root, outputDir)),
   ...summary
}, null, 3) + "\n");

async function stageBaseAssets() {
   const desktopReleaseDir = join(root, "apps", "desktop", "release");
   const evidenceDir = join(root, "docs", "release", version);
   const artifactNames = expectedArtifactNames(version);

   await rm(outputDir, { force: true, recursive: true });
   await mkdir(outputDir, { recursive: true });

   for (const name of artifactNames) {
      await copyRequired(join(desktopReleaseDir, name), join(outputDir, name));
   }

   for (const name of releaseEvidenceFiles) {
      await copyRequired(join(evidenceDir, name), join(outputDir, name));
   }

   const releaseEvidence = await readJson(join(evidenceDir, "RELEASE_EVIDENCE.json"));
   const staticValidation = await readJson(join(evidenceDir, "STATIC_VALIDATION.json"));

   if (releaseEvidence.version !== version || staticValidation.version !== version) {
      throw new Error("Release evidence version does not match package version");
   }
   if (
      staticValidation.x64?.packagedSmoke?.passed !== true
      || staticValidation.x64?.pe?.passed !== true
      || staticValidation.x64?.fuses?.passed !== true
      || staticValidation.arm64?.pe?.passed !== true
      || staticValidation.arm64?.fuses?.passed !== true
      || staticValidation.scale?.passed !== true
   ) {
      throw new Error("Static release validation is incomplete");
   }

   for (const name of artifactNames) {
      const bytes = await readFile(join(outputDir, name));
      const record = releaseEvidence.artifacts?.find((artifact) => artifact.name === name);

      if (!record) {
         throw new Error("Release evidence is missing artifact " + name);
      }
      if (record.size !== bytes.byteLength || record.sha256 !== sha256(bytes)) {
         throw new Error("Release evidence does not match artifact " + name);
      }
   }

   const desktopManifest = await readJson(join(root, "apps", "desktop", "package.json"));
   const webManifest = await readJson(join(root, "apps", "web", "package.json"));
   const serverManifest = await readJson(join(root, "apps", "server", "package.json"));
   const provenance = createBuildProvenance({
      generatedAt: new Date().toISOString(),
      product: rootManifest.name,
      version,
      source: {
         repository: rootManifest.repository.url,
         commit: sourceCommit(),
         ref: process.env.GITHUB_REF ?? localGitRef(),
         tag
      },
      builder: {
         kind: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local",
         workflow: process.env.GITHUB_WORKFLOW,
         runId: process.env.GITHUB_RUN_ID,
         runAttempt: process.env.GITHUB_RUN_ATTEMPT,
         runnerOs: process.env.RUNNER_OS ?? process.platform,
         runnerArchitecture: process.env.RUNNER_ARCH ?? process.arch
      },
      toolchain: {
         node: process.version,
         npm: npmVersion(),
         electron: desktopManifest.devDependencies.electron,
         electronBuilder: desktopManifest.devDependencies["electron-builder"],
         fastify: serverManifest.dependencies.fastify,
         specqr: webManifest.dependencies.specqr,
         typescript: rootManifest.devDependencies.typescript
      },
      gates: [
         "public-tree-audit",
         "unit-and-integration",
         "browser-electron-e2e",
         "production-build",
         "dependency-audit",
         "x64-and-arm64-portable-build",
         "electron-fuse-and-pe-validation",
         "x64-packaged-service-recovery",
         "dpi-geometry",
         "release-evidence"
      ],
      artifacts: releaseEvidence.artifacts,
      validation: {
         x64PackagedRuntimeSmoke: staticValidation.x64.packagedSmoke.passed,
         arm64BuildStatic: staticValidation.arm64.pe.passed && staticValidation.arm64.fuses.passed,
         dpiGeometry: staticValidation.scale.passed
      }
   });

   await writeJson(join(outputDir, "BUILD_PROVENANCE.json"), provenance);
}

async function finalizeAssets() {
   await access(outputDir);
   await rm(join(outputDir, "RELEASE_MANIFEST.json"), { force: true });
   await rm(join(outputDir, "SHA256SUMS.txt"), { force: true });

   const baseFiles = await readFlatAssets();
   const baseEntries = createManifestEntries(baseFiles);
   const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      product: rootManifest.name,
      version,
      tag,
      assets: baseEntries
   };

   await writeJson(join(outputDir, "RELEASE_MANIFEST.json"), manifest);

   const checksumFiles = await readFlatAssets();
   const checksumEntries = createManifestEntries(checksumFiles);

   await writeFile(
      join(outputDir, "SHA256SUMS.txt"),
      createChecksumDocument(checksumEntries),
      "utf8"
   );

   return {
      assetCount: checksumEntries.length + 1,
      checksummedAssets: checksumEntries.length
   };
}

async function readFlatAssets() {
   const entries = await readdir(outputDir, { withFileTypes: true });
   const files = [];

   for (const entry of entries) {
      if (!entry.isFile()) {
         throw new Error("Release staging directory must contain files only: " + entry.name);
      }
      if (entry.name === "SHA256SUMS.txt") {
         continue;
      }

      files.push({
         name: entry.name,
         bytes: await readFile(join(outputDir, entry.name))
      });
   }

   return files;
}

async function copyRequired(source, destination) {
   await access(source);
   await copyFile(source, destination);
}

function sourceCommit() {
   for (const value of [process.env.GITHUB_SHA, process.env.LFT_SOURCE_COMMIT]) {
      if (/^[0-9a-f]{40}$/iu.test(value ?? "")) {
         return value;
      }
   }

   return gitText(["rev-parse", "HEAD"]) ?? "unknown";
}

function localGitRef() {
   if (process.env.LFT_SOURCE_REF) {
      return process.env.LFT_SOURCE_REF;
   }

   const branch = gitText(["branch", "--show-current"]);

   return branch ? "refs/heads/" + branch : "unknown";
}

function gitText(args) {
   try {
      return execFileSync("git", [
         "-c",
         "safe.directory=" + normalize(root),
         ...args
      ], {
         cwd: root,
         encoding: "utf8",
         windowsHide: true,
         stdio: ["ignore", "pipe", "ignore"]
      }).trim();
   } catch {
      return undefined;
   }
}

function npmVersion() {
   const match = /\bnpm\/([^\s]+)/u.exec(process.env.npm_config_user_agent ?? "");

   return match?.[1] ?? "unknown";
}

function assertGeneratedDirectory(path) {
   const rel = relative(root, path);
   const segments = rel.split(sep);

   if (segments.length !== 2 || segments[0] !== "release-assets" || segments[1] !== tag) {
      throw new Error("Refusing to replace an unexpected release directory");
   }
}

async function readJson(path) {
   return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
   await writeFile(path, JSON.stringify(value, null, 3) + "\n", "utf8");
}

function normalize(path) {
   return path.split(sep).join("/");
}
