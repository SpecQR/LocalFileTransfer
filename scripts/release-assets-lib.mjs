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

export function authenticodeStatusFromPe(bytes) {
   const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

   if (buffer.byteLength < 64 || buffer.readUInt16LE(0) !== 0x5a4d) {
      throw new Error("Artifact is not a valid DOS/PE image");
   }

   const peOffset = buffer.readUInt32LE(0x3c);
   const optionalHeaderOffset = peOffset + 24;

   assertReadable(buffer, peOffset, 24, "PE header");

   if (buffer.readUInt32LE(peOffset) !== 0x00004550) {
      throw new Error("Artifact is missing the PE signature");
   }

   const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
   const optionalHeaderEnd = optionalHeaderOffset + optionalHeaderSize;

   assertReadable(buffer, optionalHeaderOffset, optionalHeaderSize, "PE optional header");

   const magic = buffer.readUInt16LE(optionalHeaderOffset);
   const dataDirectoryOffset = magic === 0x10b
      ? 96
      : magic === 0x20b
         ? 112
         : -1;

   if (dataDirectoryOffset < 0) {
      throw new Error("Artifact has an unsupported PE optional-header magic");
   }

   const securityDirectoryOffset = optionalHeaderOffset + dataDirectoryOffset + (4 * 8);

   if (securityDirectoryOffset + 8 > optionalHeaderEnd) {
      throw new Error("Artifact PE header does not contain a security directory");
   }

   const numberOfDirectories = buffer.readUInt32LE(
      optionalHeaderOffset + dataDirectoryOffset - 4
   );

   if (numberOfDirectories < 5) {
      throw new Error("Artifact PE header does not declare a security directory");
   }

   const certificateOffset = buffer.readUInt32LE(securityDirectoryOffset);
   const certificateSize = buffer.readUInt32LE(securityDirectoryOffset + 4);

   if (certificateOffset === 0 && certificateSize === 0) {
      return "NotSigned";
   }

   if (
      certificateOffset === 0
      || certificateSize < 8
      || certificateOffset % 8 !== 0
      || certificateOffset + certificateSize > buffer.byteLength
   ) {
      throw new Error("Artifact has an invalid PE certificate table");
   }

   assertCertificateTable(buffer, certificateOffset, certificateSize);

   return "PresentUnverified";
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

function assertReadable(buffer, offset, length, label) {
   if (
      !Number.isSafeInteger(offset)
      || !Number.isSafeInteger(length)
      || offset < 0
      || length < 0
      || offset + length > buffer.byteLength
   ) {
      throw new Error("Artifact has a truncated " + label);
   }
}

function assertCertificateTable(buffer, offset, size) {
   const end = offset + size;
   let cursor = offset;

   while (cursor < end) {
      assertReadable(buffer, cursor, 8, "WIN_CERTIFICATE header");

      const certificateLength = buffer.readUInt32LE(cursor);

      if (certificateLength < 8 || cursor + certificateLength > end) {
         throw new Error("Artifact has an invalid WIN_CERTIFICATE length");
      }

      cursor += Math.ceil(certificateLength / 8) * 8;
   }

   if (cursor !== end) {
      throw new Error("Artifact has invalid WIN_CERTIFICATE alignment");
   }
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
