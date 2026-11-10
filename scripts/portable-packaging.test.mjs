import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const preparePortable = require("../apps/desktop/scripts/prepare-portable.cjs");
const {
   BUILDER_VERSION,
   ORIGINAL_SHA256,
   PATCHED_SHA256,
   patchPortableTemplate
} = preparePortable;
const builderRoot = dirname(desktopRequire.resolve("app-builder-lib/package.json"));
const installedTemplate = readFileSync(join(builderRoot, "templates", "nsis", "portable.nsi"), "utf8")
   .replace(/\r\n/gu, "\n");
// Tests also run after packaging has applied the idempotent build hook. Restore
// the tiny added branch in memory, then verify the pristine upstream checksum.
const originalTemplate = installedTemplate.replace(
   /  !else\n    !ifdef APP_DIR_ARM64\n      File \/r "\$\{APP_DIR_ARM64\}\\\*\.\*"\n    !else\n([\s\S]*?)    !endif\n  !endif/u,
   (_, fallback) => "  !else\n" + fallback.replace(/^  /gmu, "") + "  !endif"
);

test("Portable workaround accepts only the reviewed upstream template", () => {
   assert.equal(sha256(originalTemplate), ORIGINAL_SHA256);
   const patched = patchPortableTemplate(BUILDER_VERSION, originalTemplate);

   assert.equal(sha256(patched), PATCHED_SHA256);
   assert.equal(patchPortableTemplate(BUILDER_VERSION, patched), patched);
   assert.equal(
      patchPortableTemplate(BUILDER_VERSION, originalTemplate.replace(/\n/gu, "\r\n")),
      patched
   );
});

test("Portable workaround rejects changed versions or unreviewed templates", () => {
   for (const version of ["26.15.2", "26.18.0", "27.0.0"]) {
      assert.throws(
         () => patchPortableTemplate(version, originalTemplate),
         /Review the Portable ARM64 template workaround/u
      );
   }

   assert.throws(
      () => patchPortableTemplate(BUILDER_VERSION, originalTemplate.replace("ExecWait", "Exec")),
      /Unexpected Portable template/u
   );

   const patched = patchPortableTemplate(BUILDER_VERSION, originalTemplate);

   assert.throws(
      () => patchPortableTemplate(BUILDER_VERSION, patched + "\n"),
      /Unexpected Portable template/u
   );
});

for (const [architecture, definition] of [["x64", "APP_DIR_64"], ["arm64", "APP_DIR_ARM64"]]) {
   test("Portable " + architecture + " selects direct extraction and retains cleanup", () => {
      const patched = patchPortableTemplate(BUILDER_VERSION, originalTemplate);
      const selected = selectPreprocessorBranches(patched, new Set([definition]));
      const files = selected.split("\n").filter((line) => line.trim().startsWith("File /r"));

      assert.deepEqual(files.map((line) => line.trim()), [
         "File /r \"${" + definition + "}\\*.*\""
      ]);
      assert.doesNotMatch(selected, /!insertmacro extractEmbeddedAppPackage/u);
      assert.equal(selected.match(/RMDir \/r \$INSTDIR/gu)?.length, 2);
      assert.match(selected, /ExecWait "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\} \$R0" \$0/u);
   });
}

test("Portable workaround is inactive for non-Windows packaging", () => {
   assert.equal(preparePortable({ electronPlatformName: "linux" }), undefined);
});

for (const expected of [
   { name: "baseline", useZip: false, compression: undefined },
   { name: "uncompressed", useZip: true, compression: "store" }
]) {
   test("startup workflow passes " + expected.name + " overrides as configuration, not a file path", () => {
      const workflow = readFileSync(new URL("../.github/workflows/portable-startup.yml", import.meta.url), "utf8");
      const commands = [...workflow.matchAll(/^\s+npx --no-install electron-builder (.+)$/gmu)];
      const command = commands.find((match) => match[1].includes("release/" + expected.name));

      assert.ok(command, "The comparison must build the " + expected.name + " artifact");
      const { configureBuildCommand, normalizeOptions } = desktopRequire("electron-builder/out/builder.js");
      const yargs = desktopRequire("yargs/yargs");
      const parsed = configureBuildCommand(yargs(command[1].trim().split(/\s+/u)))
         .parserConfiguration({ "camel-case-expansion": false })
         .exitProcess(false)
         .strict()
         .parseSync();
      const options = normalizeOptions(parsed);

      assert.equal(typeof options.config, "object");
      assert.equal(String(options.config.portable.useZip), String(expected.useZip));
      assert.equal(options.config.compression, expected.compression);
      assert.equal(options.config.directories.output, "release/" + expected.name);
      assert.equal(options.publish, "never");
   });
}

function sha256(source) {
   return createHash("sha256").update(source).digest("hex");
}

// Resolve only NSIS compile-time branches for the separate-architecture targets.
// The real Windows build additionally compiles and packages both architectures.
function selectPreprocessorBranches(source, definitions) {
   const stack = [];
   const output = [];
   let active = true;

   for (const line of source.split("\n")) {
      const condition = line.match(/^\s*!(ifdef|ifndef)\s+(\w+)\s*$/u);

      if (condition) {
         const matches = definitions.has(condition[2]) === (condition[1] === "ifdef");

         stack.push({ parent: active, matches });
         active = active && matches;
      } else if (line.trim() === "!else") {
         const frame = stack.at(-1);

         assert.ok(frame, "Unexpected NSIS !else");
         active = frame.parent && !frame.matches;
      } else if (line.trim() === "!endif") {
         const frame = stack.pop();

         assert.ok(frame, "Unexpected NSIS !endif");
         active = frame.parent;
      } else if (active) {
         output.push(line);
      }
   }

   assert.equal(stack.length, 0, "Unclosed NSIS condition");
   return output.join("\n");
}
