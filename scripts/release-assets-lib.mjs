import { createHash } from "node:crypto";

export const releaseEvidenceFiles = Object.freeze([
   "ARTIFACTS.json",
   "AUDIT-desktop.json",
   "AUDIT-root.json",
   "AUDIT-server.json",
   "AUDIT-web.json",
   "DEPENDENCIES.json",
   "LICENSES.json",
   "PACKAGED_SMOKE.json",
   "RELEASE_EVIDENCE.json",
   "RELEASE_NOTES.md",
   "SBOM-desktop.cdx.json",
   "SBOM-root.cdx.json",
   "SBOM-server.cdx.json",
   "SBOM-web.cdx.json",
   "STATIC_VALIDATION.json",
   "THIRD_PARTY_LICENSES.md",
   "scale-report.json"
]);

export function assertReleaseIdentity(version, tag) {
   if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error("Invalid release version: " + version);
   }

   const expectedTag = "v" + version;

   if (tag !== expectedTag) {
      throw new Error("Release tag " + tag + " does not match package version " + expectedTag);
   }

   return expectedTag;
}

export function expectedArtifactNames(version) {
   return [
      "Local.File.Transfer-" + version + "-arm64-Portable.exe",
      "Local.File.Transfer-" + version + "-x64-Portable.exe"
   ];
}

export function sha256(bytes) {
   return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

export function createManifestEntries(files) {
   return files
      .map(({ name, bytes }) => {
         assertPortableAssetName(name);

         return {
            name,
            size: bytes.byteLength,
            sha256: sha256(bytes)
         };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
}

export function createChecksumDocument(entries) {
   return entries
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => entry.sha256 + " *" + entry.name)
      .join("\n") + "\n";
}

export function createBuildProvenance(input) {
   const source = {
      repository: input.source.repository,
      commit: normalizeCommit(input.source.commit),
      ref: input.source.ref || "unknown",
      tag: assertReleaseIdentity(input.version, input.source.tag)
   };
   const githubRunUrl = buildRunUrl(input.source.repository, input.builder.runId);

   return {
      schemaVersion: 1,
      generatedAt: input.generatedAt,
      product: input.product,
      version: input.version,
      source,
      builder: {
         kind: input.builder.kind,
         workflow: input.builder.workflow || "local",
         runId: input.builder.runId || null,
         runAttempt: input.builder.runAttempt || null,
         runUrl: githubRunUrl,
         runnerOs: input.builder.runnerOs,
         runnerArchitecture: input.builder.runnerArchitecture
      },
      toolchain: { ...input.toolchain },
      gates: [...input.gates],
      artifacts: input.artifacts
         .map((artifact) => ({
            name: artifact.name,
            size: artifact.size,
            sha256: artifact.sha256,
            architecture: artifact.architecture,
            authenticode: artifact.authenticode
         }))
         .sort((left, right) => left.name.localeCompare(right.name)),
      claims: {
         bitForBitReproducible: false,
         rebuildableFromPinnedLocks: true,
         githubArtifactAttestationExpected: input.builder.kind === "github-actions",
         authenticodeSigned: input.artifacts.every((artifact) => artifact.authenticode === "Valid"),
         x64PackagedRuntimeSmoke: input.validation.x64PackagedRuntimeSmoke,
         arm64BuildStatic: input.validation.arm64BuildStatic,
         dpiGeometry: input.validation.dpiGeometry,
         arm64PhysicalRuntime: false,
         physicalIphoneSafari: false,
         physicalAndroidChrome: false
      }
   };
}

export function assertPortableAssetName(name) {
   if (
      typeof name !== "string"
      || name.length === 0
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")
      || name.includes(":")
      || name.includes("\0")
   ) {
      throw new Error("Unsafe release asset name: " + String(name));
   }
}

function normalizeCommit(value) {
   if (/^[0-9a-f]{40}$/iu.test(value)) {
      return value.toLowerCase();
   }

   if (value === "unknown") {
      return value;
   }

   throw new Error("Invalid source commit");
}

function buildRunUrl(repositoryUrl, runId) {
   if (!runId) {
      return null;
   }

   const match = /^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/u.exec(repositoryUrl);

   return match ? "https://github.com/" + match[1] + "/actions/runs/" + runId : null;
}
