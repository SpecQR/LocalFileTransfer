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
      const texts = await licenseTexts(directory, undefined, { ...pkg, ecosystem: "npm" });
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

      if (pkg.source !== "registry+https://github.com/rust-lang/crates.io-index") {
         throw new Error("Review source-code notices before adding a non-crates.io dependency");
      }

      const directory = dirname(pkg.manifest_path);
      const texts = await licenseTexts(directory, pkg.license_file, { ...pkg, ecosystem: "cargo" });
      const source = `https://static.crates.io/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.name)}-${encodeURIComponent(pkg.version)}.crate`;

      inventory.push({ ecosystem: "cargo", name: pkg.name, version: pkg.version, license: pkg.license ?? "UNKNOWN", source });
      notices.push(formatNotice(`cargo:${pkg.name}@${pkg.version}`, pkg.license, [
         ...texts, { name: "Corresponding source code", text: source }
      ]));
   }

   // webview2-com-sys includes Microsoft's loader as a static library. Its MIT
   // crate license does not replace the original SDK's redistribution notices.
   const loader = metadata.packages.find((pkg) => resolvedIds.has(pkg.id) && pkg.name === "webview2-com-sys");
   const sdkVersion = "1.0.3800.47";
   const sdkSource = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${sdkVersion}/microsoft.web.webview2.${sdkVersion}.nupkg`;
   const sdkSha256 = "56c9f26bdd07916a2d1949fb58a5c7e434dfa1173577dca879206050c4e718db";
   const sdkTextHashes = {
      "LICENSE.txt": "0af8f1b807512aae39c2ac1aa4d0cae65cabecb6fd554b8439a5162a0d6eca55",
      "NOTICE.txt": "106423785c5b7eba0a8e61d1837f2132e9c828e20ad530f565d981c1df60dd90"
   };
   const loaderHashes = {
      "x86_64-pc-windows-msvc": ["x64", "89c6b872783b8f6c3cedbff618adb42082d455c615453ae10cfc753f1e8f25d8"],
      "aarch64-pc-windows-msvc": ["arm64", "4a1ca4b518337c508aa0d778b220c6e59558fce21f4fd0d79a6ea944dd9d5208"]
   };
   const loaderSpec = loaderHashes[platform];

   if (!loader || loader.version !== "0.39.1" || !loaderSpec) {
      throw new Error("Review WebView2 SDK notices when changing the loader crate or target");
   }

   const loaderBytes = await readFile(join(dirname(loader.manifest_path), loaderSpec[0], "WebView2LoaderStatic.lib"));

   if (hash(loaderBytes) !== loaderSpec[1]) {
      throw new Error("The WebView2 loader differs from the reviewed Microsoft SDK");
   }

   const sdkRoot = join(previewRoot, ".cache", "webview2-sdk", sdkVersion);
   const sdkTexts = [];
   let sdkCached = true;

   for (const [name, expected] of Object.entries(sdkTextHashes)) {
      const bytes = await readFile(join(sdkRoot, name)).catch(() => null);

      if (!bytes || hash(bytes) !== expected) {
         sdkCached = false;
         break;
      }
   }

   if (!sdkCached) {
      const archive = await download(sdkSource);

      if (hash(archive) !== sdkSha256) {
         throw new Error("The Microsoft WebView2 SDK failed checksum verification");
      }

      await rm(sdkRoot, { recursive: true, force: true });
      await mkdir(sdkRoot, { recursive: true });
      const archivePath = join(sdkRoot, "sdk.zip");

      await writeFile(archivePath, archive);
      run("powershell.exe", [
         "-NoProfile", "-NonInteractive", "-Command",
         "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:LFT_SDK_ARCHIVE -DestinationPath $env:LFT_SDK_ROOT -Force"
      ], root, { LFT_SDK_ARCHIVE: archivePath, LFT_SDK_ROOT: sdkRoot });
   }

   for (const [name, expected] of Object.entries(sdkTextHashes)) {
      const bytes = await readFile(join(sdkRoot, name));

      if (hash(bytes) !== expected) {
         throw new Error("The Microsoft WebView2 SDK license or notice differs from the reviewed text");
      }

      sdkTexts.push({ name, text: `Source package: ${sdkSource}\nPackage SHA-256: ${sdkSha256}\nText SHA-256: ${expected}\n\n${bytes.toString("utf8")}` });
   }

   inventory.push({
      ecosystem: "sdk", name: "Microsoft.Web.WebView2 (static loader)", version: sdkVersion,
      license: "Microsoft WebView2 SDK license and notices", source: sdkSource,
      sourceSha256: sdkSha256, loaderSha256: loaderSpec[1]
   });
   notices.push(formatNotice(`sdk:Microsoft.Web.WebView2@${sdkVersion} (static loader)`, "see LICENSE.txt and NOTICE.txt", sdkTexts));

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

async function licenseTexts(directory, explicit, pkg) {
   const names = (await readdir(directory)).filter((name) => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(name)).sort();

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

   if (texts.length > 0) {
      return texts;
   }

   const id = pkg ? `${pkg.ecosystem}:${pkg.name}@${pkg.version}` : "unknown";
   const fallbacks = {
      "cargo:alloc-stdlib@0.3.0": {
         repository: "https://github.com/dropbox/rust-alloc-no-stdlib", license: "BSD-3-Clause",
         revision: "0a81fd6928ea3b33c8cd484aa4575d50ffb98012", path: "alloc-stdlib",
         filename: "LICENSE", sha256: "c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae"
      },
      "cargo:selectors@0.38.0": {
         repository: "https://github.com/servo/stylo", license: "MPL-2.0",
         revision: "572ecba2d1600e7c3d490586692a209faf703baa", path: "selectors",
         filename: "MPL-2.0.txt", url: "https://www.mozilla.org/media/MPL/2.0/index.txt",
         sha256: "3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04"
      },
      "cargo:webview2-com@0.39.1": {
         repository: "https://github.com/wravery/webview2-rs", license: "MIT",
         revision: "edc2caf886175ccaebe86078c9cfe1ae2a187328", path: "crates/webview2-com",
         filename: "LICENSE", sha256: "0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73"
      },
      "cargo:webview2-com-macros@0.8.1": {
         repository: "https://github.com/wravery/webview2-rs", license: "MIT",
         revision: "dffa41a8a46d3f5565eefbff2de57d38d399f158", path: "crates/callback-macros",
         filename: "LICENSE", sha256: "0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73"
      },
      "cargo:webview2-com-sys@0.39.1": {
         repository: "https://github.com/wravery/webview2-rs", license: "MIT",
         revision: "edc2caf886175ccaebe86078c9cfe1ae2a187328", path: "crates/bindings",
         filename: "LICENSE", sha256: "0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73"
      }
   };

   if (id === "npm:abstract-logging@2.0.1") {
      // This exact release links to the author's MIT permalink instead of
      // shipping LICENSE. Reproduce its plain-text, release-year view from the
      // permalink service's immutable template and author record, without
      // executing downloaded templates or checking license text into Git.
      const readme = await readFile(join(directory, "Readme.md"));

      if (pkg.license !== "MIT" || pkg.repository?.url !== "git+https://github.com/jsumners/abstract-logging.git"
         || hash(readme) !== "e1a86711fb5055c0e66901276b7d2c843554bf5f1dab218c069c8b9d17148e81") {
         throw new Error("Review the abstract-logging license fallback for this package");
      }

      const base = "https://raw.githubusercontent.com/remy/mit-license/52b34028e15bfa96c8385d768c5ef82099e9dbfe";
      const templateSource = base + "/licenses/MIT.ejs";
      const ownerSource = base + "/users/jsumners.json";
      const template = (await verifiedDownload(templateSource, "75bd0d442091ebfb2ab8f7e3a1d507686fc7c9e87a1579558e2537e7b2b447a4")).toString("utf8");
      const owner = JSON.parse((await verifiedDownload(ownerSource, "15932b5c544d31afb72ca38c331ea0f11b24f5eb12c850923392c18dd8641b75")).toString("utf8"));
      const article = template.match(/<article>([\s\S]*?)<\/article>/u)?.[1];
      const paragraphs = [...(article ?? "").matchAll(/<(h1|p)>([\s\S]*?)<\/\1>/gu)]
         .map((match) => match[2].replace("<%- info %>", `2020 ${owner.copyright} <${owner.email}>`).replace(/\s+/gu, " ").trim());

      if (paragraphs.length !== 5 || paragraphs.some((paragraph) => paragraph.includes("<%"))) {
         throw new Error("The abstract-logging license template could not be rendered");
      }

      const text = paragraphs.join("\n\n") + "\n";

      if (hash(Buffer.from(text, "utf8")) !== "8649735cd75e436ccb541103f866c716976a9ad71358fa4aca9b51cd1ae0c825") {
         throw new Error("The rendered abstract-logging license differs from the reviewed text");
      }

      return [{
         name: "MIT.txt",
         text: `Package source: https://github.com/jsumners/abstract-logging/tree/80dfaef91ee87008f4ed2b6e78921d383bccd406\nAuthor license permalink: https://jsumners.mit-license.org/@2020/license.txt\nTemplate source: ${templateSource}\nAuthor record source: ${ownerSource}\n\n${text}`
      }];
   }

   const fallback = fallbacks[id];

   if (!fallback || pkg.repository !== fallback.repository || pkg.license !== fallback.license) {
      throw new Error(`No reviewed license text is available for ${id}`);
   }

   const vcs = JSON.parse(await readFile(join(directory, ".cargo_vcs_info.json"), "utf8"));

   if (vcs.git?.sha1 !== fallback.revision || vcs.path_in_vcs !== fallback.path || vcs.git?.dirty) {
      throw new Error(`The license fallback source revision differs for ${id}`);
   }

   // selectors deliberately links to Mozilla's canonical MPL rather than
   // carrying LICENSE in its repository (upstream servo/stylo issue #317).
   const url = fallback.url ?? `${fallback.repository.replace("https://github.com/", "https://raw.githubusercontent.com/")}/${fallback.revision}/${fallback.filename}`;
   const source = `${fallback.repository}/tree/${fallback.revision}/${fallback.path}`;
   const bytes = await verifiedDownload(url, fallback.sha256);

   return [{
      name: fallback.filename,
      text: `License source: ${url}\nSHA-256: ${fallback.sha256}\nCorresponding source code (${fallback.license}): ${source}\n\n${bytes.toString("utf8")}`
   }];

   async function verifiedDownload(url, expected) {
      const cachePath = join(previewRoot, ".cache", "licenses", expected + ".txt");
      const cached = await readFile(cachePath).catch(() => null);

      if (cached && hash(cached) === expected) {
         return cached;
      }

      const bytes = await download(url);

      if (bytes.length === 0 || bytes.length > 2_000_000 || hash(bytes) !== expected) {
         throw new Error(`The reviewed license checksum differs for ${id}`);
      }

      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, bytes);
      return bytes;
   }
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
