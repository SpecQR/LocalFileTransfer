import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
   mkdtempSync,
   readFileSync,
   rmSync,
   writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
   assertPortableAssetName,
   assertReleaseIdentity,
   authenticodeStatusFromPe,
   createBuildProvenance,
   createChecksumDocument,
   createManifestEntries,
   expectedArtifactNames
} from "./release-assets-lib.mjs";

function syntheticPe({
   certificateOffset = 0,
   certificateSize = 0,
   directoryCount = 16,
   optionalHeaderSize = 240
} = {}) {
   const bytes = Buffer.alloc(512);
   const peOffset = 0x80;
   const optionalHeaderOffset = peOffset + 24;
   const securityDirectoryOffset = optionalHeaderOffset + 112 + (4 * 8);

   bytes.writeUInt16LE(0x5a4d, 0);
   bytes.writeUInt32LE(peOffset, 0x3c);
   bytes.writeUInt32LE(0x00004550, peOffset);
   bytes.writeUInt16LE(optionalHeaderSize, peOffset + 20);
   bytes.writeUInt16LE(0x20b, optionalHeaderOffset);
   bytes.writeUInt32LE(directoryCount, optionalHeaderOffset + 108);
   bytes.writeUInt32LE(certificateOffset, securityDirectoryOffset);
   bytes.writeUInt32LE(certificateSize, securityDirectoryOffset + 4);

   if (certificateSize >= 8 && certificateOffset + certificateSize <= bytes.byteLength) {
      bytes.writeUInt32LE(certificateSize, certificateOffset);
      bytes.writeUInt16LE(0x0200, certificateOffset + 4);
      bytes.writeUInt16LE(0x0002, certificateOffset + 6);
   }

   return bytes;
}

test("release identity binds package version to the exact tag", () => {
   assert.equal(assertReleaseIdentity("2.0.0-rc.5", "v2.0.0-rc.5"), "v2.0.0-rc.5");
   assert.throws(
      () => assertReleaseIdentity("2.0.0-rc.5", "v2.0.0-rc.2"),
      /does not match/u
   );
   assert.throws(() => assertReleaseIdentity("../escape", "v../escape"), /Invalid release version/u);
});

test("release artifact names are versioned and architecture-specific", () => {
   assert.deepEqual(expectedArtifactNames("2.0.0-rc.5"), [
      "Local.File.Transfer-2.0.0-rc.5-arm64-Portable.exe",
      "Local.File.Transfer-2.0.0-rc.5-x64-Portable.exe"
   ]);
});

test("manifest and checksum output are stable and sorted", () => {
   const entries = createManifestEntries([
      { name: "z.bin", bytes: Buffer.from("second") },
      { name: "a.bin", bytes: Buffer.from("first") }
   ]);

   assert.deepEqual(entries.map((entry) => entry.name), ["a.bin", "z.bin"]);
   assert.match(entries[0]?.sha256 ?? "", /^[0-9A-F]{64}$/u);
   assert.equal(
      createChecksumDocument(entries),
      entries.map((entry) => entry.sha256 + " *" + entry.name).join("\n") + "\n"
   );
});

test("PE certificate-table inspection is deterministic and conservative", () => {
   assert.equal(authenticodeStatusFromPe(syntheticPe()), "NotSigned");
   assert.equal(
      authenticodeStatusFromPe(syntheticPe({ certificateOffset: 384, certificateSize: 16 })),
      "PresentUnverified"
   );
   assert.throws(
      () => authenticodeStatusFromPe(syntheticPe({ certificateOffset: 508, certificateSize: 16 })),
      /invalid PE certificate table/u
   );
   const badCertificate = syntheticPe({ certificateOffset: 384, certificateSize: 16 });

   badCertificate.writeUInt32LE(24, 384);
   assert.throws(
      () => authenticodeStatusFromPe(badCertificate),
      /invalid WIN_CERTIFICATE length/u
   );
   assert.throws(
      () => authenticodeStatusFromPe(syntheticPe({ optionalHeaderSize: 2 })),
      /does not contain a security directory/u
   );
   assert.throws(
      () => authenticodeStatusFromPe(syntheticPe({ directoryCount: 4 })),
      /does not declare a security directory/u
   );
   assert.throws(() => authenticodeStatusFromPe(Buffer.from("not a PE")), /valid DOS\/PE image/u);
});

test("portable artifact inspector CLI emits canonical JSON", () => {
   const scriptsDir = dirname(fileURLToPath(import.meta.url));
   const directory = mkdtempSync(join(tmpdir(), "lft-artifact-inspection-"));
   const artifactPath = join(directory, "fixture.exe");

   try {
      writeFileSync(artifactPath, syntheticPe());

      const output = execFileSync(process.execPath, [
         join(scriptsDir, "inspect-release-artifact.mjs"),
         artifactPath
      ], {
         encoding: "utf8",
         windowsHide: true
      });
      const inspection = JSON.parse(output);

      assert.equal(inspection.length, 512);
      assert.match(inspection.sha256, /^[0-9A-F]{64}$/u);
      assert.equal(inspection.authenticodeStatus, "NotSigned");
   } finally {
      rmSync(directory, { recursive: true, force: true });
   }
});

test("release asset names cannot escape the staging directory", () => {
   for (const name of ["../file", "folder/file", "folder\\file", "C:drive", ""]) {
      assert.throws(() => assertPortableAssetName(name), /Unsafe release asset name/u);
   }
});

test("build provenance contains only allowlisted public context", () => {
   const provenance = createBuildProvenance({
      generatedAt: "2026-07-16T00:00:00.000Z",
      product: "local-file-transfer",
      version: "2.0.0-rc.5",
      source: {
         repository: "https://github.com/SpecQR/LocalFileTransfer.git",
         commit: "a".repeat(40),
         ref: "refs/tags/v2.0.0-rc.5",
         tag: "v2.0.0-rc.5"
      },
      builder: {
         kind: "github-actions",
         workflow: "RC.5 prerelease",
         runId: "12345",
         runAttempt: "1",
         runnerOs: "Windows",
         runnerArchitecture: "X64"
      },
      toolchain: {
         node: "v22.0.0",
         npm: "10.0.0",
         specqr: "2.4.0"
      },
      gates: ["test"],
      artifacts: [{
         name: "Local.File.Transfer-2.0.0-rc.5-x64-Portable.exe",
         size: 1,
         sha256: "A".repeat(64),
         architecture: "x64",
         authenticode: "NotSigned"
      }],
      validation: {
         x64PackagedRuntimeSmoke: true,
         arm64BuildStatic: true,
         dpiGeometry: true
      }
   });
   const serialized = JSON.stringify(provenance);

   assert.equal(
      provenance.builder.runUrl,
      "https://github.com/SpecQR/LocalFileTransfer/actions/runs/12345"
   );
   assert.equal(provenance.claims.authenticodeSigned, false);
   assert.equal(provenance.claims.x64PackagedRuntimeSmoke, true);
   assert.equal(provenance.claims.arm64BuildStatic, true);
   assert.equal(provenance.claims.bitForBitReproducible, false);
   assert.doesNotMatch(serialized, /Users|\\\\Mac|iCloud|kifu/iu);
});


test("packaged smoke PowerShell parses before release", () => {
   const scriptsDir = dirname(fileURLToPath(import.meta.url));
   const smokePath = join(scriptsDir, "test-packaged-windows.ps1");

   execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$source=Get-Content -LiteralPath $env:LFT_SMOKE_SCRIPT -Raw -Encoding UTF8; [void][scriptblock]::Create($source)"
   ], {
      env: {
         ...process.env,
         LFT_SMOKE_SCRIPT: smokePath
      },
      windowsHide: true
   });

   const smokeSource = readFileSync(smokePath, "utf8");

   assert.doesNotMatch(smokeSource, /Get-FileHash|Get-AuthenticodeSignature/u);
   assert.match(smokeSource, /inspect-release-artifact\.mjs/u);
});
