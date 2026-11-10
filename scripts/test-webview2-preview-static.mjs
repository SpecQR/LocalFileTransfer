import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { authenticodeStatusFromPe } from "./release-assets-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const preview = join(root, "apps/webview2");
const manifest = JSON.parse(await readFile(join(preview, "preview.json"), "utf8"));
const evidenceDirectory = join(root, "test-results/webview2-preview");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const artifacts = [];

for (const architecture of ["x64", "arm64"]) {
   const stage = join(preview, "release", architecture);
   const build = JSON.parse(await readFile(join(stage, "BUILD.json"), "utf8"));
   requireCheck(build.version === manifest.version && build.architecture === architecture, "Build identity mismatch");
   requireCheck(build.sourceCommit === sourceCommit, "Build source commit mismatch");
   requireCheck(build.nodeVersion === manifest.nodeVersion && build.rustVersion === manifest.rustVersion, "Build toolchain mismatch");
   const executables = [];

   for (const name of ["LocalFileTransferPreview.exe", "LocalFileTransferService.exe"]) {
      const bytes = await readFile(join(stage, name));
      const machine = peMachine(bytes);
      requireCheck(machine === (architecture === "x64" ? 0x8664 : 0xaa64), "Executable architecture mismatch");
      const sha256 = digest(bytes);
      const entry = build.files.find((value) => value.name === name);
      requireCheck(entry?.sha256 === sha256 && entry.bytes === bytes.length, "Executable build hash mismatch");
      const signature = authenticodeStatusFromPe(bytes);
      requireCheck(signature === "NotSigned", "Preview contains an unexpected executable signature");
      executables.push({ name, bytes: bytes.length, sha256, machine: "0x" + machine.toString(16).toUpperCase(), signature });
   }

   for (const name of ["web/index.html", "README.md", "LICENSE.txt", "THIRD_PARTY_NOTICES.txt", "DEPENDENCIES.json"]) {
      requireCheck((await readFile(join(stage, name))).length > 0, "Distribution resource missing");
   }
   const name = `Local.File.Transfer-WebView2-Preview-${manifest.version}-${architecture}.zip`;
   const bytes = await readFile(join(preview, "release", name));
   requireCheck(bytes.readUInt32LE(0) === 0x04034b50, "Invalid ZIP header");
   artifacts.push({ name, architecture, bytes: bytes.length, sha256: digest(bytes), executables, staticValidationPassed: true });
}

await mkdir(evidenceDirectory, { recursive: true });
const smoke = JSON.parse(await readFile(join(evidenceDirectory, "WEBVIEW2_SMOKE.json"), "utf8"));
requireCheck(smoke.archiveSha256 === artifacts[0].sha256 && smoke.version === manifest.version, "Smoke evidence does not match the exact x64 ZIP");
requireCheck(smoke.extractedDistributionTested && smoke.desktopReadyBeforeInterruption && smoke.gracefulWindowClose && smoke.endpointClosed && smoke.residualProcesses === 0, "Packaged lifecycle gate failed");
requireCheck(smoke.transfer?.nativeFilePickerToDownloadPassed && smoke.transfer?.rangeDownloadPassed && smoke.transfer?.uploadToReceiveDirectoryPassed && smoke.transfer?.checkpointReplayPassed && smoke.transfer?.sharedTextConflictPassed, "Transfer gate failed");
requireCheck(smoke.sharedText?.nativeSharedTextUiPassed && smoke.recovery?.durableUploadResumedAfterServiceCrash && smoke.recovery?.sharedTextPreserved && smoke.recovery?.roomPreserved, "Packaged recovery gate failed");
const report = {
   schemaVersion: 1,
   previewVersion: manifest.version,
   sourceCommit,
   nodeVersion: manifest.nodeVersion,
   rustVersion: manifest.rustVersion,
   workflowRun: process.env.GITHUB_RUN_ID ?? null,
   repository: process.env.GITHUB_REPOSITORY ?? null,
   artifacts,
   x64PackagedSmoke: smoke,
   arm64RuntimeMeasured: false,
   physicalPhoneTested: false,
   trustedLanRequired: true,
   authenticodeSigned: false,
   reproducibleBuildClaimed: false
};
const reportName = "WEBVIEW2_PREVIEW_EVIDENCE.json";
const json = JSON.stringify(report, null, 3) + "\n";
await writeFile(join(evidenceDirectory, reportName), json);
await writeFile(join(evidenceDirectory, "SHA256SUMS.txt"), [
   ...artifacts.map((entry) => entry.sha256 + "  " + entry.name),
   digest(Buffer.from(json)) + "  " + reportName
].join("\n") + "\n");
process.stdout.write(JSON.stringify({ previewVersion: manifest.version, sourceCommit, artifacts, x64PackagedSmokePassed: true, arm64RuntimeMeasured: false }, null, 3) + "\n");

function digest(bytes) {
   return createHash("sha256").update(bytes).digest("hex");
}

function requireCheck(value, message) {
   if (!value) throw new Error(message);
}

function peMachine(bytes) {
   requireCheck(bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ", "Invalid DOS header");
   const offset = bytes.readUInt32LE(0x3c);
   requireCheck(offset + 6 <= bytes.length && bytes.toString("ascii", offset, offset + 4) === "PE\0\0", "Invalid PE signature");
   return bytes.readUInt16LE(offset + 4);
}
