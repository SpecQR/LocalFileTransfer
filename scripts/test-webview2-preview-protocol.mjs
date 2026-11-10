import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const phase = process.argv[process.argv.indexOf("--phase") + 1];
const firstNote = "WebView2 preview: HTTP shared text";
const nativeNote = "WebView2 preview: native shared text";
const outboundBytes = fixture(512 * 1024 + 17, 7);
const inboundBytes = fixture(1024 * 1024 + 67, 19);
const resumableBytes = fixture(2 * 1024 * 1024 + 31, 29);
const checkpointSize = 1024 * 1024;
let operation = "read-input";

class SmokeFailure extends Error {}

try {
   let input = "";
   process.stdin.setEncoding("utf8");
   for await (const chunk of process.stdin) {
      input += chunk;
      check(input.length <= 64 * 1024, "input-too-large");
   }
   check(input.length > 0, "input-empty");
   operation = "parse-input";
   // .NET Framework may emit a UTF-8 preamble when it creates redirected stdin.
   const settings = JSON.parse(input.replace(/^\uFEFF/u, ""));
   check(settings && ["fixturePath", "statePath", "receiveDir"].every((key) => typeof settings[key] === "string" && settings[key].length > 0), "invalid-fixture-settings");

   if (phase === "prepare") {
      operation = "write-fixture";
      await writeFile(settings.fixturePath, outboundBytes);
      operation = "write-state";
      await writeFile(settings.statePath, JSON.stringify({ schemaVersion: 1 }));
      output({ prepared: true });
   } else {
      operation = "exercise-http";
      await exercise(settings);
   }
} catch (error) {
   // Never print a URL, credential, file path, response body, or file contents.
   const fileErrors = ["ENOENT", "EACCES", "EPERM", "EEXIST", "ENOSPC", "EINVAL", "EISDIR", "ENOTDIR"];
   const kind = error instanceof SyntaxError ? "syntax-error"
      : error instanceof TypeError ? "type-error"
         : fileErrors.includes(error?.code) ? error.code.toLowerCase() : "unexpected-error";
   const code = error instanceof SmokeFailure ? error.message : operation + "-" + kind;
   process.stderr.write("WEBVIEW2_PROTOCOL_FAILURE=" + code + "\n");
   process.exitCode = 1;
}

async function exercise(settings) {
   check(["exercise", "verify-ui", "recover"].includes(phase), "invalid-phase");
   const link = new URL(settings.joinUrl);
   check(link.protocol === "http:" && !link.username && !link.password, "invalid-room-link");
   const roomId = decodeURIComponent(link.pathname.slice("/room/".length));
   const token = new URLSearchParams(link.hash.slice(1)).get("t");
   check(link.pathname.startsWith("/room/") && /^[A-Za-z0-9_-]+$/u.test(roomId), "invalid-room-id");
   check(typeof token === "string" && /^[A-Za-z0-9_-]{43}$/u.test(token), "invalid-room-capability");
   check(Number(link.port) >= 8787 && Number(link.port) < 8807, "unexpected-service-port");
   const origin = "http://127.0.0.1:" + link.port;
   const root = "/api/v2/rooms/" + roomId;
   let cookie;

   async function request(path, options = {}, expected = 200) {
      const response = await fetch(origin + path, {
         ...options,
         headers: { origin, ...(cookie ? { cookie } : {}), ...options.headers },
         signal: AbortSignal.timeout(30_000)
      });
      check(response.status === expected, "http-status-" + response.status + "-expected-" + expected);
      return response;
   }

   const authorization = await request(root + "/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token })
   }, 204);
   const setCookie = authorization.headers.getSetCookie().find((value) => /;\s*HttpOnly(?:;|$)/iu.test(value));
   check(Boolean(setCookie), "missing-httponly-cookie");
   cookie = setCookie.split(";", 1)[0];
   const state = JSON.parse(await readFile(settings.statePath, "utf8"));

   async function room() {
      return (await request(root)).json();
   }

   async function download(itemId, bytes, range = false) {
      const response = await request(root + "/files/" + itemId + "/content", {
         headers: range ? { range: "bytes=31-255" } : {}
      }, range ? 206 : 200);
      const received = Buffer.from(await response.arrayBuffer());
      check(hash(received) === hash(range ? bytes.subarray(31, 256) : bytes), "download-digest-mismatch");
   }

   async function register(name, bytes) {
      const response = await request(root + "/uploads", {
         method: "POST",
         headers: { "content-type": "application/json" },
         body: JSON.stringify({
            name,
            type: "application/octet-stream",
            size: bytes.length,
            lastModified: 1_700_000_000_000,
            fingerprint: createHash("sha256").update(name).update(bytes).digest("base64url")
         })
      }, 201);
      return (await response.json()).item.itemId;
   }

   async function head(itemId, expectedOffset) {
      const response = await request(root + "/uploads/" + itemId, { method: "HEAD" }, 204);
      check(Number(response.headers.get("upload-offset")) === expectedOffset, "durable-offset-mismatch");
   }

   async function append(itemId, bytes, offset) {
      const chunk = bytes.subarray(offset, Math.min(offset + checkpointSize, bytes.length));
      const checksum = createHash("sha256").update(chunk).digest("base64");
      const key = createHash("sha256").update([
         "lft-checkpoint-v1", roomId, itemId, String(offset), String(chunk.length), checksum
      ].join("\n")).digest("base64url");
      await request(root + "/uploads/" + itemId, {
         method: "PATCH",
         headers: {
            "content-type": "application/offset+octet-stream",
            "upload-offset": String(offset),
            "upload-checksum": "sha256 " + checksum,
            "idempotency-key": key
         },
         body: chunk
      }, 204);
   }

   async function receivedFile(name, bytes) {
      const paths = await filesUnder(settings.receiveDir);
      const path = paths.find((candidate) => basename(candidate) === name);
      check(Boolean(path), "received-file-missing");
      check(hash(await readFile(path)) === hash(bytes), "received-file-digest-mismatch");
   }

   if (phase === "exercise") {
      let outbound;
      for (let attempt = 0; attempt < 100 && !outbound; attempt += 1) {
         outbound = (await room()).items.find((item) => item.name === basename(settings.fixturePath) && item.direction === "windows_to_device");
         if (!outbound) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      check(Boolean(outbound), "native-file-picker-did-not-register-file");
      await download(outbound.itemId, outboundBytes);
      await download(outbound.itemId, outboundBytes, true);
      const inboundId = await register("preview-inbound.bin", inboundBytes);
      await head(inboundId, 0);
      await append(inboundId, inboundBytes, 0);
      await append(inboundId, inboundBytes, 0);
      await head(inboundId, checkpointSize);
      await append(inboundId, inboundBytes, checkpointSize);
      await head(inboundId, inboundBytes.length);
      await receivedFile("preview-inbound.bin", inboundBytes);

      const shared = await (await request(root + "/shared-text")).json();
      await request(root + "/shared-text", {
         method: "PUT",
         headers: { "content-type": "application/json" },
         body: JSON.stringify({ content: firstNote, expectedRevision: shared.revision })
      });
      await request(root + "/shared-text", {
         method: "PUT",
         headers: { "content-type": "application/json" },
         body: JSON.stringify({ content: "stale edit", expectedRevision: shared.revision })
      }, 409);
      const partialId = await register("preview-resumed.bin", resumableBytes);
      await append(partialId, resumableBytes, 0);
      await head(partialId, checkpointSize);
      await writeFile(settings.statePath, JSON.stringify({
         schemaVersion: 1, roomId, outboundId: outbound.itemId, inboundId, partialId
      }));
      output({
         authorizedViaHttpOnlyCookie: true,
         nativeFilePickerToDownloadPassed: true,
         rangeDownloadPassed: true,
         uploadToReceiveDirectoryPassed: true,
         checkpointReplayPassed: true,
         sharedTextConflictPassed: true,
         partialUploadPrepared: true
      });
      return;
   }

   check(state.roomId === roomId, "room-not-preserved");
   const shared = await (await request(root + "/shared-text")).json();
   check(shared.content === nativeNote, "native-shared-text-mismatch");
   if (phase === "verify-ui") {
      output({ nativeSharedTextUiPassed: true });
      return;
   }

   await download(state.outboundId, outboundBytes);
   await receivedFile("preview-inbound.bin", inboundBytes);
   await head(state.partialId, checkpointSize);
   for (let offset = checkpointSize; offset < resumableBytes.length; offset += checkpointSize) {
      await append(state.partialId, resumableBytes, offset);
   }
   await head(state.partialId, resumableBytes.length);
   await receivedFile("preview-resumed.bin", resumableBytes);
   output({
      roomPreserved: true,
      nativeFilePreserved: true,
      receivedFilePreserved: true,
      sharedTextPreserved: true,
      durableUploadResumedAfterServiceCrash: true
   });
}

function check(condition, code) {
   if (!condition) throw new SmokeFailure(code);
}

function fixture(length, seed) {
   const bytes = Buffer.alloc(length);
   for (let index = 0; index < length; index += 1) bytes[index] = (index * seed + 31) & 255;
   return bytes;
}

function hash(bytes) {
   return createHash("sha256").update(bytes).digest("hex");
}

function output(value) {
   process.stdout.write(JSON.stringify(value) + "\n");
}

async function filesUnder(directory) {
   const result = [];
   for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await filesUnder(path));
      else if (entry.isFile()) result.push(path);
   }
   return result;
}
