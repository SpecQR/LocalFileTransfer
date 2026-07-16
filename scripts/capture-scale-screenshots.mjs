import { _electron as electron } from "@playwright/test";
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
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(root, "apps", "desktop");
const electronPackageRoot = join(desktopRoot, "node_modules", "electron");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const outputDir = join(root, "docs", "release", version, "screenshots");
const scales = [1, 1.25, 1.5, 2];
const executablePath = await ensureLocalElectron();
const reports = [];

await mkdir(outputDir, { recursive: true });

for (const scale of scales) {
   reports.push(await capture(scale));
}

await writeFile(
   join(outputDir, "scale-report.json"),
   JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      version,
      reports
   }, null, 3) + "\n",
   "utf8"
);
process.stdout.write(JSON.stringify({ outputDir, reports }, null, 3) + "\n");

async function capture(scale) {
   const label = Math.round(scale * 100);
   const runRoot = await mkdtemp(join(tmpdir(), "lft-scale-" + label + "-"));
   const userData = join(runRoot, "user-data");
   const storageDir = join(runRoot, "storage");
   const receiveDir = join(runRoot, "received");
   const screenshotPath = join(outputDir, "desktop-" + label + ".png");
   const sharedTextScreenshotPath = join(outputDir, "desktop-" + label + "-shared-text.png");
   let app;

   try {
      await Promise.all([
         mkdir(userData, { recursive: true }),
         mkdir(storageDir, { recursive: true }),
         mkdir(receiveDir, { recursive: true })
      ]);
      app = await electron.launch({
         executablePath,
         args: [
            desktopRoot,
            "--force-device-scale-factor=" + scale,
            "--lang=en-US",
            "--user-data-dir=" + userData
         ],
         cwd: desktopRoot,
         env: {
            ...process.env,
            LFT_STORAGE_DIR: storageDir,
            LFT_RECEIVE_DIR: receiveDir
         },
         timeout: 60_000
      });
      const page = await app.firstWindow();

      await page.locator(".room-qr-square svg").waitFor({ state: "visible" });
      await page.waitForTimeout(250);
      const contentSize = await app.evaluate(({ BrowserWindow }) => {
         const window = BrowserWindow.getAllWindows()[0];

         return window ? window.getContentSize() : [0, 0];
      });
      const metrics = await page.evaluate(() => {
         const qr = document.querySelector(".room-qr-square");

         if (!(qr instanceof HTMLElement)) {
            throw new Error("QR region is unavailable");
         }

         const bounds = qr.getBoundingClientRect();

         return {
            devicePixelRatio: window.devicePixelRatio,
            documentClientWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            documentClientHeight: document.documentElement.clientHeight,
            documentScrollHeight: document.documentElement.scrollHeight,
            qrWidth: bounds.width,
            qrHeight: bounds.height
         };
      });

      if (contentSize[0] !== 300) {
         throw new Error("Content width changed at " + label + "%: " + contentSize[0]);
      }

      if (Math.abs(metrics.qrWidth - metrics.qrHeight) > 1) {
         throw new Error("QR region is not square at " + label + "%");
      }

      if (metrics.documentScrollWidth > metrics.documentClientWidth + 1) {
         throw new Error("Horizontal overflow at " + label + "%");
      }

      if (metrics.documentScrollHeight > metrics.documentClientHeight + 1) {
         throw new Error("Document overflow at " + label + "%");
      }

      await page.screenshot({
         path: screenshotPath,
         animations: "disabled"
      });
      const dimensions = pngDimensions(await readFile(screenshotPath));

      await page.getByTestId("shared-text-open").click();
      const dialog = page.getByRole("dialog");

      await dialog.waitFor({ state: "visible" });
      const sharedTextMetrics = await page.evaluate(() => {
         const panel = document.querySelector(".shared-text-dialog");
         const textarea = document.querySelector(".shared-text-dialog textarea");

         if (!(panel instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement)) {
            throw new Error("Shared text dialog is incomplete");
         }

         const panelBounds = panel.getBoundingClientRect();
         const textareaBounds = textarea.getBoundingClientRect();

         return {
            panelLeft: panelBounds.left,
            panelTop: panelBounds.top,
            panelRight: panelBounds.right,
            panelBottom: panelBounds.bottom,
            textareaWidth: textareaBounds.width,
            textareaHeight: textareaBounds.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
         };
      });

      if (
         sharedTextMetrics.panelLeft < -1
         || sharedTextMetrics.panelTop < -1
         || sharedTextMetrics.panelRight > sharedTextMetrics.viewportWidth + 1
         || sharedTextMetrics.panelBottom > sharedTextMetrics.viewportHeight + 1
      ) {
         throw new Error("Shared text dialog is clipped at " + label + "%");
      }

      if (sharedTextMetrics.textareaWidth < 220 || sharedTextMetrics.textareaHeight < 110) {
         throw new Error("Shared text editor is too small at " + label + "%");
      }

      await page.screenshot({
         path: sharedTextScreenshotPath,
         animations: "disabled"
      });
      const sharedTextDimensions = pngDimensions(await readFile(sharedTextScreenshotPath));

      return {
         requestedScale: scale,
         screenshot: "desktop-" + label + ".png",
         screenshotPixels: dimensions,
         sharedTextScreenshot: "desktop-" + label + "-shared-text.png",
         sharedTextScreenshotPixels: sharedTextDimensions,
         sharedTextMetrics,
         contentSize,
         ...metrics
      };
   } finally {
      await app?.close();
      await rm(runRoot, { force: true, recursive: true });
   }
}

async function ensureLocalElectron() {
   const packageJson = JSON.parse(
      await readFile(join(electronPackageRoot, "package.json"), "utf8")
   );
   const cacheRoot = join(tmpdir(), "local-file-transfer-e2e-electron-" + packageJson.version);
   const runtimeRoot = join(cacheRoot, "dist");
   const executable = join(runtimeRoot, "electron.exe");

   try {
      await access(executable);
   } catch {
      await mkdir(cacheRoot, { recursive: true });
      await rm(runtimeRoot, { force: true, recursive: true });
      await cp(join(electronPackageRoot, "dist"), runtimeRoot, {
         force: true,
         recursive: true
      });
   }

   return executable;
}

function pngDimensions(bytes) {
   const signature = bytes.subarray(0, 8).toString("hex");

   if (signature !== "89504e470d0a1a0a") {
      throw new Error("Screenshot is not a PNG");
   }

   return {
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20)
   };
}
