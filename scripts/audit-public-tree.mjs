import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const publicVersion = rootManifest.version;
const skippedDirectories = new Set([
   ".git",
   ".data",
   "coverage",
   "dist",
   "node_modules",
   "playwright-report",
   "release-assets",
   "test-results"
]);
const forbiddenNames = new Set([
   ".DS_Store",
   "WORKLOG.md",
   "PUBLICATION_PLAN.md",
   "RC2_PRESERVED_ARTIFACTS.json",
   "electron-builder.preview.json"
]);
const forbiddenExtensions = new Set([
   ".db",
   ".exe",
   ".key",
   ".p12",
   ".pem",
   ".pfx",
   ".sqlite"
]);
const textExtensions = new Set([
   "",
   ".cjs",
   ".css",
   ".html",
   ".js",
   ".json",
   ".md",
   ".mjs",
   ".ps1",
   ".ts",
   ".tsx",
   ".txt",
   ".yaml",
   ".yml"
]);
const problems = [];
const files = [];

await walk(root);

for (const path of files) {
   const rel = normalize(relative(root, path));
   const info = await stat(path);
   const extension = extname(path).toLowerCase();
   const name = rel.split("/").at(-1) ?? rel;

   if (forbiddenNames.has(name)) {
      problems.push(`${rel}: forbidden publication file`);
   }

   if (name === ".env" || name.startsWith(".env.")) {
      problems.push(`${rel}: environment file is not public source`);
   }

   if (forbiddenExtensions.has(extension) || name.includes(".lft-part-")) {
      problems.push(`${rel}: generated, private, or executable artifact`);
   }

   if (info.size > 10 * 1024 * 1024) {
      problems.push(`${rel}: file exceeds the 10 MiB source-tree limit`);
   }

   if (!textExtensions.has(extension)) {
      problems.push(`${rel}: unreviewed binary or file type ${extension || "<none>"}`);
      continue;
   }

   const content = await readFile(path, "utf8");
   inspectText(rel, content);
}

await inspectManifest();
await requireFiles();
await inspectWorkflowPins();

if (problems.length > 0) {
   process.stderr.write("Public tree audit failed:\n" + problems.map((problem) => `- ${problem}`).join("\n") + "\n");
   process.exitCode = 1;
} else {
   process.stdout.write(JSON.stringify({
      root: ".",
      filesScanned: files.length,
      version: publicVersion,
      specqr: "2.4.0",
      result: "pass"
   }, null, 3) + "\n");
}

async function walk(directory) {
   for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
         continue;
      }

      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
         await walk(path);
      } else if (entry.isFile()) {
         files.push(path);
      } else {
         problems.push(`${normalize(relative(root, path))}: symbolic or special files are not allowed`);
      }
   }
}

function inspectText(rel, content) {
   if (content.includes("\0")) {
      problems.push(`${rel}: NUL byte detected in a text file`);
   }

   const windowsUser = new RegExp("[A-Za-z]:[\\\\/]+Users[\\\\/]+([^\\\\/\\s]+)", "giu");
   for (const match of content.matchAll(windowsUser)) {
      const user = (match[1] ?? "").toLowerCase();
      if (!["person", "public", "test", "user"].includes(user)) {
         problems.push(`${rel}: local Windows user path detected`);
      }
   }

   const macUser = new RegExp("/" + "Users/([^/\\s]+)", "gu");
   for (const match of content.matchAll(macUser)) {
      const user = (match[1] ?? "").toLowerCase();
      if (!["person", "shared", "test", "user"].includes(user)) {
         problems.push(`${rel}: local macOS user path detected`);
      }
   }

   const privatePathFragments = [
      "\\\\" + "Mac\\Home",
      "Mac" + "\\Home",
      "i" + "Cloud/",
      "i" + "Cloud\\"
   ];
   if (privatePathFragments.some((fragment) => content.includes(fragment))) {
      problems.push(`${rel}: private host or cloud-drive path detected`);
   }

   const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
   for (const match of content.matchAll(email)) {
      if (
         !rel.endsWith("package-lock.json")
         && !(match[0] ?? "").endsWith("@users.noreply.github.com")
      ) {
         problems.push(`${rel}: personal or unreviewed email address detected`);
      }
   }

   const tokenPrefixes = ["gh" + "p_", "github" + "_pat_", ["A", "K", "I", "A"].join("")];
   if (tokenPrefixes.some((prefix) => content.includes(prefix))) {
      problems.push(`${rel}: token-like credential prefix detected`);
   }

   if (content.includes("-----BEGIN " + "PRIVATE KEY-----")) {
      problems.push(`${rel}: private key material detected`);
   }
}

async function inspectManifest() {
   const manifests = [
      ["package.json", rootManifest],
      ["apps/server/package.json", JSON.parse(await readFile(join(root, "apps", "server", "package.json"), "utf8"))],
      ["apps/web/package.json", JSON.parse(await readFile(join(root, "apps", "web", "package.json"), "utf8"))],
      ["apps/desktop/package.json", JSON.parse(await readFile(join(root, "apps", "desktop", "package.json"), "utf8"))],
      ["packages/protocol/package.json", JSON.parse(await readFile(join(root, "packages", "protocol", "package.json"), "utf8"))],
      ["packages/shared/package.json", JSON.parse(await readFile(join(root, "packages", "shared", "package.json"), "utf8"))]
   ];
   const webManifest = manifests.find(([path]) => path === "apps/web/package.json")?.[1];

   if (!/^\d+\.\d+\.\d+-rc\.\d+$/u.test(publicVersion)) {
      problems.push("package.json: public version must be an RC prerelease");
   }
   for (const [path, manifest] of manifests) {
      if (manifest.version !== publicVersion) {
         problems.push(path + ": version does not match package.json");
      }
   }
   if (rootManifest.license !== "MIT") {
      problems.push("package.json: license must be MIT");
   }
   if (rootManifest.repository?.url !== "https://github.com/SpecQR/LocalFileTransfer.git") {
      problems.push("package.json: unexpected repository URL");
   }
   if (webManifest.dependencies?.specqr !== "2.4.0") {
      problems.push("apps/web/package.json: SpecQR must be pinned exactly to 2.4.0");
   }
}

async function requireFiles() {
   const required = [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      "AGENTS.md",
      "CHANGELOG.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "LICENSE",
      "README.md",
      "SECURITY.md",
      "docs/AI_CONTEXT.md",
      "docs/ARCHITECTURE.md",
      "docs/BUILD_AND_RELEASE.md",
      "docs/LICENSE_JA.md",
      "docs/MANUAL_TEST_CHECKLIST.md",
      "docs/PRIVACY.md",
      "docs/RELIABILITY.md",
      "docs/PROJECT_LANGUAGE.md",
      "docs/PROTOCOL.md",
      "docs/SECURITY_MODEL.md",
      "docs/SHARED_TEXT_DESIGN.md",
      "docs/SPECQR_INTEGRATION.md",
      "docs/TEST_STRATEGY.md",
      "docs/release/" + publicVersion + "/RELEASE_NOTES.md",
      "scripts/release-assets-lib.mjs",
      "scripts/release-assets-lib.test.mjs",
      "scripts/stage-release-assets.mjs",
      "scripts/test-packaged-windows.ps1"
   ];
   const existing = new Set(files.map((path) => normalize(relative(root, path))));
   for (const rel of required) {
      if (!existing.has(rel)) {
         problems.push(`${rel}: required public documentation is missing`);
      }
   }
}

async function inspectWorkflowPins() {
   const workflowPaths = [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml"
   ];

   for (const rel of workflowPaths) {
      const content = await readFile(join(root, ...rel.split("/")), "utf8");
      const externalActions = [];

      for (const [index, line] of content.split(/\r?\n/u).entries()) {
         const match = line.match(/^\s*uses:\s*["']?([^"'#\s]+)["']?/u);

         if (!match) {
            continue;
         }

         const action = match[1];

         if (action.startsWith("./")) {
            continue;
         }

         externalActions.push(action);
         const separator = action.lastIndexOf("@");
         const reference = separator >= 0 ? action.slice(separator + 1) : "";

         if (!/^[a-f0-9]{40}$/iu.test(reference)) {
            problems.push(`${rel}:${index + 1}: external action must use an immutable 40-character commit SHA`);
         }
      }

      if (externalActions.length === 0) {
         problems.push(`${rel}: workflow must use at least one pinned external action`);
      }
   }

   const release = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
   const requiredMarkers = [
      "if: github.ref_type == 'tag'",
      "id-token: write",
      "attestations: write",
      "npm run release:stage",
      "actions/attest@",
      "gh attestation verify",
      "npm run release:finalize",
      "--prerelease"
   ];

   for (const marker of requiredMarkers) {
      if (!release.includes(marker)) {
         problems.push(`.github/workflows/release.yml: required release safeguard is missing: ${marker}`);
      }
   }
}

function normalize(path) {
   return path.split(sep).join("/");
}
