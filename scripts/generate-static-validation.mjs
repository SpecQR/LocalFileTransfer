import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps", "desktop");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const evidenceDirectory = join(root, "docs", "release", version);
const artifacts = readJson(join(evidenceDirectory, "ARTIFACTS.json")).artifacts;
const packagedSmoke = readJson(join(evidenceDirectory, "PACKAGED_SMOKE.json"));
const scaleReport = readJson(join(evidenceDirectory, "scale-report.json"));
const releaseConfig = runJson(process.execPath, ["scripts/verify-release-config.cjs"], desktop);
const signing = verifyMissingSigningInputs();

const x64 = inspectArchitecture("x64", "0x8664", "win-unpacked");
const arm64 = inspectArchitecture("arm64", "0xAA64", "win-arm64-unpacked");
const report = {
   schemaVersion: 1,
   generatedAt: new Date().toISOString(),
   version,
   releaseConfig,
   sharedText: {
      schemaVersion: 3,
      maximumUtf8Bytes: 64 * 1024,
      persistence: "AES-256-GCM ciphertext with a room capability-derived HKDF-SHA-256 key",
      endToEndEncrypted: false,
      eventPayload: "revision only"
   },
   signing,
   x64: {
      ...x64,
      packagedSmoke: {
         passed: packagedSmoke.initialHealthStatus === 200
            && packagedSmoke.recoveredHealthStatus === 200
            && packagedSmoke.gracefulWindowClose === true
            && packagedSmoke.endpointClosed === true
            && packagedSmoke.residualProcesses === 0,
         ...packagedSmoke
      }
   },
   arm64: {
      ...arm64,
      physicalRuntimeGate: "Not run; requires a physical Windows on ARM device"
   },
   scale: {
      factors: scaleReport.reports.map((entry) => entry.requestedScale),
      passed: scaleReport.reports.every((entry) => (
         entry.documentScrollWidth === entry.documentClientWidth
         && entry.qrWidth === entry.qrHeight
         && entry.sharedTextMetrics.panelLeft >= 0
         && entry.sharedTextMetrics.panelRight <= entry.sharedTextMetrics.viewportWidth
         && entry.sharedTextMetrics.panelBottom <= entry.sharedTextMetrics.viewportHeight
      )),
      report: "scale-report.json"
   }
};

writeFileSync(
   join(evidenceDirectory, "STATIC_VALIDATION.json"),
   JSON.stringify(report, null, 3) + "\n",
   "utf8"
);

process.stdout.write(JSON.stringify({
   version,
   x64Machine: x64.pe.machineHex,
   arm64Machine: arm64.pe.machineHex,
   x64Fuses: x64.fuses.passed,
   arm64Fuses: arm64.fuses.passed,
   packagedSmoke: report.x64.packagedSmoke.passed,
   scale: report.scale.passed
}, null, 3) + "\n");

function inspectArchitecture(architecture, expectedMachineHex, unpackedDirectory) {
   const artifact = artifacts.find((entry) => entry.architecture === architecture);
   if (!artifact) {
      throw new Error(`Missing ${architecture} artifact evidence`);
   }

   const executable = join(desktop, "release", unpackedDirectory, "Local File Transfer.exe");
   const machineHex = readPeMachine(executable);
   if (machineHex !== expectedMachineHex) {
      throw new Error(`${architecture} PE machine expected ${expectedMachineHex} but found ${machineHex}`);
   }

   const values = runJson(
      process.execPath,
      ["scripts/verify-fuses.cjs", executable],
      desktop
   );

   return {
      artifact,
      pe: {
         machineHex,
         expectedMachineHex,
         passed: true
      },
      fuses: {
         passed: true,
         values
      }
   };
}

function readPeMachine(path) {
   const bytes = readFileSync(path);
   if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`Invalid PE DOS header: ${path}`);
   }

   const peOffset = bytes.readUInt32LE(0x3c);
   if (bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
      throw new Error(`Invalid PE signature: ${path}`);
   }

   return "0x" + bytes.readUInt16LE(peOffset + 4).toString(16).toUpperCase();
}

function verifyMissingSigningInputs() {
   const env = { ...process.env };
   for (const name of [
      "WIN_CSC_LINK",
      "WIN_CSC_KEY_PASSWORD",
      "CSC_LINK",
      "CSC_KEY_PASSWORD"
   ]) {
      delete env[name];
   }

   const result = spawnSync(
      process.execPath,
      ["scripts/require-signing-env.cjs"],
      { cwd: desktop, env, encoding: "utf8" }
   );

   if (result.status === 0) {
      throw new Error("Signing validation unexpectedly accepted missing inputs");
   }

   return {
      credentialsEmbedded: false,
      missingInputsRejected: true
   };
}

function runJson(executable, args, cwd) {
   const output = execFileSync(executable, args, { cwd, encoding: "utf8" });
   return JSON.parse(output);
}

function readJson(path) {
   return JSON.parse(readFileSync(path, "utf8"));
}
