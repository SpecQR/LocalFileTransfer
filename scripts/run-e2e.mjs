import { createHash } from "node:crypto";
import {
   access,
   cp,
   mkdir,
   mkdtemp,
   readFile,
   rm,
   writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockBytes = await readFile(join(repositoryRoot, "package-lock.json"));
const cacheKey = createHash("sha256").update(lockBytes).digest("hex").slice(0, 16);
const cacheRoot = join(tmpdir(), `local-file-transfer-playwright-${cacheKey}`);
const cachedModules = join(cacheRoot, "node_modules");
const playwrightCli = join(cachedModules, "playwright", "cli.js");

try {
   await access(playwrightCli);
} catch {
   await mkdir(cacheRoot, { recursive: true });
   await rm(cachedModules, {
      force: true,
      recursive: true
   });
   await cp(join(repositoryRoot, "node_modules"), cachedModules, {
      force: true,
      recursive: true
   });
}

const runRoot = await mkdtemp(join(cacheRoot, "run-"));
let exitCode = 1;

try {
   await cp(
      join(repositoryRoot, "playwright.config.ts"),
      join(runRoot, "playwright.config.ts")
   );
   await cp(join(repositoryRoot, "tests"), join(runRoot, "tests"), {
      force: true,
      recursive: true
   });
   await writeFile(join(runRoot, "package.json"), JSON.stringify({
      private: true,
      type: "module"
   }, null, 3));

   exitCode = await runPlaywright(playwrightCli, runRoot);
   await Promise.all([
      copyArtifact(runRoot, repositoryRoot, "test-results"),
      copyArtifact(runRoot, repositoryRoot, "playwright-report")
   ]);
} finally {
   if (process.env.LFT_KEEP_E2E_HARNESS !== "1") {
      await rm(runRoot, {
         force: true,
         recursive: true
      });
   }
}

process.exitCode = exitCode;

function runPlaywright(cliPath, cwd) {
   return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [
         cliPath,
         "test",
         ...process.argv.slice(2)
      ], {
         cwd,
         env: {
            ...process.env,
            LFT_REPOSITORY_ROOT: repositoryRoot
         },
         stdio: "inherit"
      });

      child.on("error", rejectPromise);
      child.on("exit", (code) => resolvePromise(code ?? 1));
   });
}

async function copyArtifact(sourceRoot, destinationRoot, name) {
   const source = join(sourceRoot, name);
   const destination = join(destinationRoot, name);

   try {
      await access(source);
   } catch {
      return;
   }

   await rm(destination, {
      force: true,
      recursive: true
   });
   await cp(source, destination, {
      force: true,
      recursive: true
   });
}