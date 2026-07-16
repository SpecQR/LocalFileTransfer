import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
   assertPortableAssetName,
   assertReleaseIdentity,
   createBuildProvenance,
   createChecksumDocument,
   createManifestEntries,
   expectedArtifactNames
} from "./release-assets-lib.mjs";

test("release identity binds package version to the exact tag", () => {
   assert.equal(assertReleaseIdentity("2.0.0-rc.3", "v2.0.0-rc.3"), "v2.0.0-rc.3");
   assert.throws(
      () => assertReleaseIdentity("2.0.0-rc.3", "v2.0.0-rc.2"),
      /does not match/u
   );
   assert.throws(() => assertReleaseIdentity("../escape", "v../escape"), /Invalid release version/u);
});

test("release artifact names are versioned and architecture-specific", () => {
   assert.deepEqual(expectedArtifactNames("2.0.0-rc.3"), [
      "Local.File.Transfer-2.0.0-rc.3-arm64-Portable.exe",
      "Local.File.Transfer-2.0.0-rc.3-x64-Portable.exe"
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

test("release asset names cannot escape the staging directory", () => {
   for (const name of ["../file", "folder/file", "folder\\file", "C:drive", ""]) {
      assert.throws(() => assertPortableAssetName(name), /Unsafe release asset name/u);
   }
});

test("build provenance contains only allowlisted public context", () => {
   const provenance = createBuildProvenance({
      generatedAt: "2026-07-16T00:00:00.000Z",
      product: "local-file-transfer",
      version: "2.0.0-rc.3",
      source: {
         repository: "https://github.com/SpecQR/LocalFileTransfer.git",
         commit: "a".repeat(40),
         ref: "refs/tags/v2.0.0-rc.3",
         tag: "v2.0.0-rc.3"
      },
      builder: {
         kind: "github-actions",
         workflow: "RC.3 prerelease",
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
         name: "Local.File.Transfer-2.0.0-rc.3-x64-Portable.exe",
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
});
