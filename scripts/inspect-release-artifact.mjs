import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
   authenticodeStatusFromPe,
   sha256
} from "./release-assets-lib.mjs";

const inputPath = process.argv[2];

if (!inputPath) {
   throw new Error("Usage: node scripts/inspect-release-artifact.mjs <portable.exe>");
}

const artifactPath = resolve(inputPath);
const bytes = await readFile(artifactPath);

process.stdout.write(JSON.stringify({
   length: bytes.byteLength,
   sha256: sha256(bytes),
   authenticodeStatus: authenticodeStatusFromPe(bytes)
}) + "\n");
