import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { authenticodeStatusFromPe } from "../../../scripts/release-assets-lib.mjs";

const previewRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(previewRoot, "../..");
const manifest = JSON.parse(await readFile(join(previewRoot, "preview.json"), "utf8"));
const dist = join(previewRoot, "dist");
const args = process.argv.slice(2);
const arch = args[args.indexOf("--arch") + 1];
const bridgeOnly = args.includes("--bridge-only");
const bundleOnly = args.includes("--bundle-only");

await mkdir(dist, { recursive: true });
await build({
   entryPoints: [join(previewRoot, "bridge.ts")],
   outfile: join(dist, "bridge.js"),
   bundle: true,
   format: "iife",
   platform: "browser",
   target: "es2022",
   legalComments: "none"
});

if (bridgeOnly) {
   console.log("WebView2 bridge built");
   process.exit(0);
}

const serviceBundle = await build({
   entryPoints: [join(previewRoot, "service/src/main.ts")],
   outfile: join(dist, "service.cjs"),
   bundle: true,
   format: "cjs",
   platform: "node",
   target: "node24",
   metafile: true,
   legalComments: "none"
});

if (bundleOnly) {
   console.log("WebView2 bridge and standalone service built");
   process.exit(0);
}

if (process.platform !== "win32" || !["x64", "arm64"].includes(arch)) {
   throw new Error("Windows packaging requires Windows and --arch x64 or --arch arm64");
}

if (process.versions.node !== manifest.nodeVersion) {
   throw new Error("SEA generation requires the exact Node.js version from preview.json");
}

const target = arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc";
const releaseRoot = join(previewRoot, "release");
const stage = join(releaseRoot, arch);
const cache = join(previewRoot, ".cache", manifest.nodeVersion);
const nativeRoot = join(previewRoot, "native");
const nodeFileName = `win-${arch}/node.exe`;
const nodeBase = `https://nodejs.org/dist/v${manifest.nodeVersion}/`;

await mkdir(cache, { recursive: true });
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

// Verify the exact official runtime before turning it into our service executable.
const sums = await download(nodeBase + "SHASUMS256.txt");
const expectedHash = sums.toString("utf8").split(/\r?\n/u)
   .map((line) => line.trim().split(/\s+/u))
   .find((parts) => parts[1] === nodeFileName)?.[0];

if (!expectedHash || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
   throw new Error("The official Node.js checksum is missing");
}

const cachedNode = join(cache, `node-${arch}.exe`);
let nodeBytes = await readFile(cachedNode).catch(() => null);

if (!nodeBytes || hash(nodeBytes) !== expectedHash) {
   nodeBytes = await download(nodeBase + nodeFileName);

   if (hash(nodeBytes) !== expectedHash) {
      throw new Error("The downloaded Node.js runtime failed checksum verification");
   }

   await writeFile(cachedNode, nodeBytes);
}

const blobPath = join(dist, `service-${arch}.blob`);
const configPath = join(dist, `sea-${arch}.json`);
await writeJson(configPath, {
   main: join(dist, "service.cjs"),
   output: blobPath,
   disableExperimentalSEAWarning: true,
   useSnapshot: false,
   useCodeCache: false,
   execArgvExtension: "none"
});
run(process.execPath, ["--experimental-sea-config", configPath]);

const serviceExe = join(stage, "LocalFileTransferService.exe");
await copyFile(cachedNode, serviceExe);
run(await findSignTool(), ["remove", "/s", serviceExe]);
const require = createRequire(import.meta.url);
const { inject } = require("postject");
await inject(serviceExe, "NODE_SEA_BLOB", await readFile(blobPath), {
   sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
});

run("cargo", [
   `+${manifest.rustVersion}`, "build", "--locked", "--release", "--target", target
], nativeRoot);
await copyFile(
   join(nativeRoot, "target", target, "release", "LocalFileTransferPreview.exe"),
   join(stage, "LocalFileTransferPreview.exe")
);
await cp(join(root, "apps/web/dist"), join(stage, "web"), { recursive: true });
await copyFile(join(root, "LICENSE"), join(stage, "LICENSE.txt"));
await copyFile(join(root, "docs/WEBVIEW2_PREVIEW.md"), join(stage, "README.md"));

const dependencyEvidence = await collectDependencies(serviceBundle.metafile, target);
await writeJson(join(stage, "DEPENDENCIES.json"), dependencyEvidence.inventory);
await writeFile(join(stage, "THIRD_PARTY_NOTICES.txt"), dependencyEvidence.notices, "utf8");

const files = [];
for (const name of ["LocalFileTransferPreview.exe", "LocalFileTransferService.exe"]) {
   const bytes = await readFile(join(stage, name));
   const peOffset = bytes.readUInt32LE(0x3c);
   const machine = bytes.readUInt16LE(peOffset + 4);

   if (machine !== (arch === "x64" ? 0x8664 : 0xaa64)) {
      throw new Error("A staged executable has the wrong architecture");
   }

   const signature = authenticodeStatusFromPe(bytes);

   if (signature !== "NotSigned") {
      throw new Error("Preview executables must not contain stale Authenticode signatures");
   }

   files.push({ name, bytes: bytes.length, sha256: hash(bytes), machine, signature });
}

await writeJson(join(stage, "BUILD.json"), {
   schemaVersion: 1,
   version: manifest.version,
   architecture: arch,
   sourceCommit: runText("git", ["rev-parse", "HEAD"], root).trim(),
   nodeVersion: manifest.nodeVersion,
   nodeSourceSha256: expectedHash,
   rustVersion: manifest.rustVersion,
   webview: "Microsoft Edge WebView2 Evergreen Runtime (installed separately)",
   packaging: "Extract the ZIP once; no per-launch extraction",
   files
});

const archiveName = `Local.File.Transfer-WebView2-Preview-${manifest.version}-${arch}.zip`;
const archivePath = join(releaseRoot, archiveName);
await rm(archivePath, { force: true });
run("powershell.exe", [
   "-NoProfile", "-NonInteractive", "-Command",
   "Compress-Archive -Path (Join-Path $env:LFT_PREVIEW_STAGE '*') -DestinationPath $env:LFT_PREVIEW_ARCHIVE -CompressionLevel Optimal"
], root, { LFT_PREVIEW_STAGE: stage, LFT_PREVIEW_ARCHIVE: archivePath });
console.log(JSON.stringify({
   archive: archiveName,
   bytes: (await stat(archivePath)).size,
   sha256: hash(await readFile(archivePath)),
   files
}, null, 3));

async function collectDependencies(metafile, platform) {
   const inventory = [];
   const notices = [];
   const seen = new Set();
   const npmDirectories = new Set();

   // Include every installed production dependency of the shipped service/UI.
   // The bundle inputs also capture any dependency used outside these scopes.
   for (const scope of ["server", "web", "desktop"]) {
      const directory = join(root, "apps", scope);
      const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));

      for (const [name, record] of Object.entries(lock.packages)) {
         if (name && !record.dev) {
            npmDirectories.add(join(directory, name));
         }
      }
   }

   for (const name of Object.keys(metafile.inputs)) {
      const normalized = resolve(name).replaceAll("\\", "/");
      const match = normalized.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//u);

      if (match) {
         npmDirectories.add(match[1]);
      }
   }

   for (const directory of npmDirectories) {
      const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      const id = `npm:${pkg.name}@${pkg.version}`;

      if (seen.has(id)) {
         continue;
      }

      seen.add(id);
      const texts = await licenseTexts(directory);
      inventory.push({ ecosystem: "npm", name: pkg.name, version: pkg.version, license: pkg.license ?? "UNKNOWN" });
      notices.push(formatNotice(id, pkg.license, texts));
   }

   const metadata = JSON.parse(runText("cargo", [
      `+${manifest.rustVersion}`, "metadata", "--locked", "--format-version", "1", "--filter-platform", platform
   ], nativeRoot));
   const resolvedIds = new Set(metadata.resolve.nodes.map((entry) => entry.id));

   for (const pkg of metadata.packages) {
      if (!resolvedIds.has(pkg.id) || !pkg.source) {
         continue;
      }

      const directory = dirname(pkg.manifest_path);
      const texts = await licenseTexts(directory, pkg.license_file);
      inventory.push({ ecosystem: "cargo", name: pkg.name, version: pkg.version, license: pkg.license ?? "UNKNOWN" });
      notices.push(formatNotice(`cargo:${pkg.name}@${pkg.version}`, pkg.license, texts));
   }

   const nodeLicense = (await download(
      `https://raw.githubusercontent.com/nodejs/node/v${manifest.nodeVersion}/LICENSE`
   )).toString("utf8");
   notices.unshift(`Node.js ${manifest.nodeVersion}\n\n${nodeLicense}`);
   inventory.unshift({ ecosystem: "runtime", name: "Node.js", version: manifest.nodeVersion, license: "MIT and bundled third-party licenses" });
   return {
      inventory: { schemaVersion: 1, dependencies: inventory },
      notices: notices.join("\n\n" + "=".repeat(72) + "\n\n") + "\n"
   };
}

async function licenseTexts(directory, explicit) {
   const names = (await readdir(directory)).filter((name) => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(name));

   if (explicit && !names.includes(explicit)) {
      names.push(explicit);
   }

   const texts = [];
   for (const name of names) {
      const path = join(directory, name);
      const info = await stat(path);

      if (info.isFile() && info.size <= 2_000_000) {
         texts.push({ name: basename(name), text: await readFile(path, "utf8") });
      }
   }

   return texts;
}

function formatNotice(id, license, texts) {
   return `${id}\nLicense: ${license ?? "see upstream package"}\n\n` + texts
      .map((entry) => `${entry.name}\n\n${entry.text}`).join("\n\n");
}

async function findSignTool() {
   const sdk = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
   const versions = (await readdir(sdk)).filter((entry) => /^10\./u.test(entry)).sort().reverse();

   for (const version of versions) {
      const candidate = join(sdk, version, "x64", "signtool.exe");

      if (await access(candidate).then(() => true, () => false)) {
         return candidate;
      }
   }

   throw new Error("Windows SDK signtool is required to package the preview");
}

async function download(url) {
   const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });

   if (!response.ok) {
      throw new Error(`Build dependency download failed (HTTP ${response.status})`);
   }

   return Buffer.from(await response.arrayBuffer());
}

function run(command, commandArgs, cwd = root, extraEnv = {}) {
   const result = spawnSync(command, commandArgs, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
      windowsHide: true
   });

   if (result.error || result.status !== 0) {
      throw new Error(`Build step failed: ${basename(command)}`);
   }
}

function runText(command, commandArgs, cwd) {
   const result = spawnSync(command, commandArgs, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
   });

   if (result.error || result.status !== 0) {
      throw new Error(`Build metadata step failed: ${basename(command)}`);
   }

   return result.stdout;
}

function hash(bytes) {
   return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(path, value) {
   await writeFile(path, JSON.stringify(value, null, 3) + "\n", "utf8");
}
