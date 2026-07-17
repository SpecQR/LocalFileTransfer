import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
   access,
   mkdir,
   readFile,
   readdir,
   writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
   authenticodeStatusFromPe,
   sha256
} from "./release-assets-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = await readJson(join(root, "package.json"));
const version = rootManifest.version;
const outputDir = join(root, "docs", "release", version);
const generatedAt = new Date().toISOString();
const scopes = [
   { name: "root", directory: root },
   { name: "server", directory: join(root, "apps", "server") },
   { name: "web", directory: join(root, "apps", "web") },
   { name: "desktop", directory: join(root, "apps", "desktop") }
];

await mkdir(outputDir, { recursive: true });

const inventory = new Map();
const licenseFiles = new Map();
const auditSummaries = {};
const sbomSummaries = {};

for (const scope of scopes) {
   const lockPath = join(scope.directory, "package-lock.json");
   const lock = await readJson(lockPath);

   collectInventory(scope, lock, inventory);
   await collectLicenseFiles(scope, lock, licenseFiles);

   const sbom = runNpmJson(scope.directory, [
      "sbom",
      "--sbom-format",
      "cyclonedx",
      "--package-lock-only"
   ]);
   const sbomName = "SBOM-" + scope.name + ".cdx.json";

   await writeJson(join(outputDir, sbomName), sbom);
   sbomSummaries[scope.name] = {
      file: sbomName,
      format: sbom.bomFormat,
      specVersion: sbom.specVersion,
      components: Array.isArray(sbom.components) ? sbom.components.length : 0
   };

   const audit = runNpmJson(scope.directory, ["audit", "--json"]);
   const auditName = "AUDIT-" + scope.name + ".json";

   await writeJson(join(outputDir, auditName), audit);
   auditSummaries[scope.name] = audit.metadata?.vulnerabilities ?? {};
}

const dependencies = [...inventory.values()].sort((left, right) => (
   left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
));
const licenses = buildLicenseInventory(dependencies, licenseFiles);
const artifacts = await artifactEvidence(version);
const nodeVersion = process.version;
const npmVersion = runNpmText(root, ["--version"]);

await writeJson(join(outputDir, "DEPENDENCIES.json"), {
   schemaVersion: 1,
   generatedAt,
   version,
   dependencies
});
await writeJson(join(outputDir, "LICENSES.json"), {
   schemaVersion: 1,
   generatedAt,
   version,
   licenses
});
await writeFile(
   join(outputDir, "THIRD_PARTY_LICENSES.md"),
   licenseMarkdown(version, licenses),
   "utf8"
);
await writeJson(join(outputDir, "ARTIFACTS.json"), {
   schemaVersion: 1,
   generatedAt,
   version,
   artifacts
});
await writeJson(join(outputDir, "RELEASE_EVIDENCE.json"), {
   schemaVersion: 1,
   generatedAt,
   product: rootManifest.name,
   version,
   runtime: {
      node: nodeVersion,
      npm: npmVersion,
      platform: process.platform,
      architecture: process.arch
   },
   dependencyCount: dependencies.length,
   licenseExpressionCount: licenses.length,
   sboms: sbomSummaries,
   audits: auditSummaries,
   artifacts: artifacts.map(({ name, size, sha256, architecture, authenticode }) => ({
      name,
      size,
      sha256,
      architecture,
      authenticode
   }))
});

process.stdout.write(JSON.stringify({
   outputDir,
   dependencyCount: dependencies.length,
   licenseExpressionCount: licenses.length,
   sboms: sbomSummaries,
   audits: auditSummaries,
   artifacts: artifacts.length
}, null, 3) + "\n");

function collectInventory(scope, lock, target) {
   for (const [lockPath, record] of Object.entries(lock.packages ?? {})) {
      if (!record.version || lockPath === "") {
         continue;
      }

      const name = record.name ?? packageNameFromLockPath(lockPath);

      if (!name) {
         continue;
      }

      const key = name + "@" + record.version;
      const existing = target.get(key) ?? {
         name,
         version: record.version,
         license: record.license ?? "UNKNOWN",
         development: record.dev === true,
         optional: record.optional === true,
         scopes: []
      };

      if (!existing.scopes.includes(scope.name)) {
         existing.scopes.push(scope.name);
      }

      existing.development = existing.development && record.dev === true;
      existing.optional = existing.optional || record.optional === true;
      target.set(key, existing);
   }
}

async function collectLicenseFiles(scope, lock, target) {
   for (const [lockPath, record] of Object.entries(lock.packages ?? {})) {
      if (!record.version || !lockPath) {
         continue;
      }

      const name = record.name ?? packageNameFromLockPath(lockPath);

      if (!name) {
         continue;
      }

      const packageDir = join(scope.directory, ...lockPath.split("/"));

      try {
         const names = await readdir(packageDir);
         const files = names.filter((candidate) => /^(?:licen[cs]e|copying|notice)(?:\..+)?$/iu.test(candidate));

         for (const file of files) {
            const content = await readFile(join(packageDir, file));
            const hash = createHash("sha256").update(content).digest("hex");
            const key = name + "@" + record.version;
            const current = target.get(key) ?? [];

            if (!current.some((entry) => entry.sha256 === hash)) {
               current.push({ file, sha256: hash, bytes: content.byteLength });
            }

            target.set(key, current);
         }
      } catch {
         // Optional and platform-specific packages may not be installed on this machine.
      }
   }
}

function buildLicenseInventory(dependencies, files) {
   const grouped = new Map();

   for (const dependency of dependencies) {
      const expression = dependency.license || "UNKNOWN";
      const group = grouped.get(expression) ?? {
         expression,
         dependencies: []
      };
      const key = dependency.name + "@" + dependency.version;

      group.dependencies.push({
         name: dependency.name,
         version: dependency.version,
         licenseFiles: files.get(key) ?? []
      });
      grouped.set(expression, group);
   }

   return [...grouped.values()].sort((left, right) => left.expression.localeCompare(right.expression));
}

async function artifactEvidence(releaseVersion) {
   const releaseDir = join(root, "apps", "desktop", "release");
   let names = [];

   try {
      names = await readdir(releaseDir);
   } catch {
      return [];
   }

   const prefix = "Local.File.Transfer-" + releaseVersion + "-";
   const matching = names.filter((name) => name.startsWith(prefix) && name.endsWith(".exe")).sort();
   const results = [];

   for (const name of matching) {
      const path = join(releaseDir, name);
      const bytes = await readFile(path);

      results.push({
         name,
         size: bytes.byteLength,
         sha256: sha256(bytes),
         architecture: name.includes("-arm64-") ? "arm64" : name.includes("-x64-") ? "x64" : "unknown",
         authenticode: authenticodeStatusFromPe(bytes)
      });
   }

   return results;
}

function packageNameFromLockPath(lockPath) {
   const marker = "node_modules/";
   const index = lockPath.lastIndexOf(marker);

   return index >= 0 ? lockPath.slice(index + marker.length) : basename(lockPath);
}

function runNpmJson(cwd, args) {
   const npmCli = process.env.npm_execpath;

   if (!npmCli) {
      throw new Error("npm_execpath is unavailable; run through npm run release:evidence");
   }

   const result = spawnSync(process.execPath, [npmCli, ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
   });
   if (result.error) {
      throw result.error;
   }

   const output = result.stdout.trim();

   if (!output) {
      throw new Error("npm " + args[0] + " produced no JSON in " + cwd + "\n" + result.stderr);
   }

   const parsed = JSON.parse(output);

   if (args[0] !== "audit" && result.status !== 0) {
      throw new Error("npm " + args[0] + " failed in " + cwd + "\n" + result.stderr);
   }

   const vulnerabilities = parsed.metadata?.vulnerabilities;

   if (args[0] === "audit" && vulnerabilities?.total !== 0) {
      throw new Error("npm audit reported vulnerabilities in " + cwd);
   }

   return parsed;
}

function runNpmText(cwd, args) {
   const npmCli = process.env.npm_execpath;

   if (!npmCli) {
      throw new Error("npm_execpath is unavailable");
   }

   return execFileSync(process.execPath, [npmCli, ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true
   }).trim();
}

function licenseMarkdown(releaseVersion, groups) {
   const lines = [
      "# Third-party license inventory（第三者ライセンス一覧）",
      "",
      "Local File Transfer " + releaseVersion,
      "",
      "Pinned package lock と installed package の license metadata から生成した一覧です。",
      ""
   ];

   for (const group of groups) {
      lines.push("## " + group.expression, "");

      for (const dependency of group.dependencies) {
         const files = dependency.licenseFiles.length > 0
            ? dependency.licenseFiles.map((entry) => entry.file + " (SHA-256 " + entry.sha256 + ")").join(", ")
            : "installed package 内に license file が見つかりません";

         lines.push("- " + dependency.name + "@" + dependency.version + ": " + files);
      }

      lines.push("");
   }

   return lines.join("\n").trimEnd() + "\n";
}

async function readJson(path) {
   await access(path);
   return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
   await writeFile(path, JSON.stringify(value, null, 3) + "\n", "utf8");
}
