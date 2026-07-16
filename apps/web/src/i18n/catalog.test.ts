import assert from "node:assert/strict";
import test from "node:test";
import { catalogForLanguages, resolveLocale } from "./catalog.ts";

test("selects Japanese from browser language priority and otherwise uses English", () => {
   assert.equal(resolveLocale(["ja-JP", "en-US"]), "ja");
   assert.equal(resolveLocale(["fr-FR", "en-US"]), "en");
   assert.equal(resolveLocale([]), "en");
});

test("English and Japanese catalogs expose typed stable dynamic messages", () => {
   const english = catalogForLanguages(["en-US"]);
   const japanese = catalogForLanguages(["ja-JP"]);

   assert.equal(english.messages.uploadCount(3), "Upload 3");
   assert.equal(japanese.messages.uploadCount(3), "3 件をアップロード");
   assert.equal(english.messages.downloadAll(4), "Download all (4)");
   assert.equal(japanese.messages.downloadAll(4), "すべてダウンロード (4)");
});
