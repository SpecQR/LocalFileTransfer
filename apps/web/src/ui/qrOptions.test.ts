import assert from "node:assert/strict";
import test from "node:test";
import { QRCode } from "specqr";
import { selectQrErrorCorrectionLevel } from "./qrOptions.ts";

test("keeps M when L does not reduce the QR version", () => {
   assert.equal(selectQrErrorCorrectionLevel("https://transfer.local/r/abc#t=123"), "M");
});

test("uses L when it reduces the QR version", () => {
   let candidate: string | undefined;

   for (let length = 1; length <= 1200; length += 1) {
      const value = `https://transfer.local/r/session#t=${"a".repeat(length)}`;
      const low = QRCode.estimate(value, { errorCorrectionLevel: "L" });
      const medium = QRCode.estimate(value, { errorCorrectionLevel: "M" });

      if (low.ok && medium.ok && low.selectedVersion < medium.selectedVersion) {
         candidate = value;
         break;
      }
   }

   assert.ok(candidate, "expected a URL where L reduces the selected version");
   assert.equal(selectQrErrorCorrectionLevel(candidate), "L");
});