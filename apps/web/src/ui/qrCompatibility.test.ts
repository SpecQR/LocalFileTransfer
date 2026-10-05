import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { QRCode } from "specqr";
import { selectQrErrorCorrectionLevel } from "./qrOptions.ts";

// Synthetic room capabilities only. Baselines were captured with SpecQR 2.4.0.
const fixtures = [
   {
      host: "192.168.1.2:8787",
      version: 5,
      svgSha256: "c8a2652a4154d7e6e0000885e2b79195218322e215f796b9ffd6c0397aed8b01"
   },
   {
      host: "192.168.100.200:65535",
      version: 5,
      svgSha256: "995bfbecade5d9a4501148022f1a7038d480c78b2515147956cabab3877fbbab"
   },
   {
      host: "[2001:db8:1234:5678:90ab:cdef:1234:5678]:65535",
      version: 6,
      svgSha256: "5913590c25f6ba176f03c4c3fb827c52da8dee9aaaa01a2c4b1b16c4e935b993"
   },
   {
      host: "transfer.local:8787",
      version: 5,
      svgSha256: "a009e52363bbb97cca63fa5dc44ef90b5de53da8ce7f6426fd3d7e0685178445"
   }
] as const;

for (const fixture of fixtures) {
   test("SpecQR preserves room SVG and four-module quiet zone for " + fixture.host, () => {
      const value = "http://" + fixture.host + "/room/AbCdEfGhIjKlMnOpQrStUv#t="
         + "aBcD0123_-".repeat(4) + "xYz";
      const errorCorrectionLevel = selectQrErrorCorrectionLevel(value);
      const plan = QRCode.estimate(value, { errorCorrectionLevel });

      assert.equal(plan.ok, true);
      assert.equal(errorCorrectionLevel, "L");
      assert.equal(plan.selectedVersion, fixture.version);

      const svg = QRCode.generate(value, {
         errorCorrectionLevel,
         margin: 4,
         output: "svg",
         scale: 1
      });
      const side = 17 + 4 * fixture.version + 2 * 4;

      assert.ok(svg.includes('viewBox="0 0 ' + side + " " + side + '"'));
      assert.equal(
         createHash("sha256").update(svg).digest("hex"),
         fixture.svgSha256
      );
   });
}
