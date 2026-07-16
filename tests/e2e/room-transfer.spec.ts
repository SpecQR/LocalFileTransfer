import {
   _electron as electron,
   expect,
   test,
   type ElectronApplication
} from "@playwright/test";
import { createHash } from "node:crypto";
import {
   access,
   cp,
   mkdir,
   mkdtemp,
   readFile,
   rm,
   stat,
   writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = process.env.LFT_REPOSITORY_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const desktopRoot = join(repositoryRoot, "apps", "desktop");
const electronPackageRoot = join(desktopRoot, "node_modules", "electron");

interface DesktopBootstrap {
   roomId: string;
   joinUrl: string;
   expiresAt: number;
}

test("one QR room transfers both ways and keeps the compact desktop layout stable", async ({
   browserName,
   page
}, testInfo) => {
   const mobileText = testInfo.project.name === "iphone-webkit"
      ? {
         connected: "接続済み",
         diagnostics: "診断情報",
         copyDiagnostics: "診断情報をコピー",
         copied: "コピー済み",
         downloadAll: (count: number) => "すべてダウンロード (" + count + ")",
         downloadFile: (name: string) => name + " \u3092\u30c0\u30a6\u30f3\u30ed\u30fc\u30c9",
         pause: "一時停止",
         resume: "再開",
         upload: (count: number) => count + " 件をアップロード"
      }
      : {
         connected: "Connected",
         diagnostics: "Diagnostics",
         copyDiagnostics: "Copy diagnostics",
         copied: "Copied",
         downloadAll: (count: number) => "Download all (" + count + ")",
         downloadFile: (name: string) => "Download " + name,
         pause: "Pause",
         resume: "Resume",
         upload: (count: number) => "Upload " + count
      };
   const executablePath = await ensureLocalElectron();
   const runRoot = await mkdtemp(join(tmpdir(), `lft-e2e-${browserName}-`));
   const userData = join(runRoot, "user-data");
   const storageDir = join(runRoot, "storage");
   const receiveDir = join(runRoot, "received");
   const fixturesDir = join(runRoot, "fixtures");

   await Promise.all([
      mkdir(userData, { recursive: true }),
      mkdir(storageDir, { recursive: true }),
      mkdir(receiveDir, { recursive: true }),
      mkdir(fixturesDir, { recursive: true })
   ]);

   const outbound = await createOutboundFixtures(fixturesDir);
   const inbound = await createInboundFixtures(fixturesDir);
   let electronApp: ElectronApplication | undefined;

   try {
      electronApp = await electron.launch({
         executablePath,
         args: [
            desktopRoot,
            "--lang=en-US",
            `--user-data-dir=${userData}`
         ],
         cwd: desktopRoot,
         env: {
            ...process.env,
            LFT_STORAGE_DIR: storageDir,
            LFT_RECEIVE_DIR: receiveDir
         },
         timeout: 60_000
      });

      const desktopPage = await electronApp.firstWindow();
      const desktopText = await desktopPage.evaluate(() => navigator.languages.some(
         (language) => language.toLowerCase().startsWith("ja")
      ))
         ? {
            connected: "接続済み",
            diagnostics: "診断情報",
            copyDiagnostics: "診断情報をコピー",
            copied: "コピー済み"
         }
         : {
            connected: "Connected",
            diagnostics: "Diagnostics",
            copyDiagnostics: "Copy diagnostics",
            copied: "Copied"
         };

      await expect(desktopPage.locator(".room-desktop")).toBeVisible();
      await expect(desktopPage.getByText(desktopText.connected, { exact: true })).toBeVisible();

      const bootstrap = await desktopPage.evaluate<DesktopBootstrap>(async () => {
         const host = globalThis as unknown as {
            localFileTransfer: {
               roomBootstrap(): Promise<DesktopBootstrap>;
            };
         };

         return host.localFileTransfer.roomBootstrap();
      });
      const joinUrl = new URL(bootstrap.joinUrl);

      joinUrl.hostname = "127.0.0.1";
      await page.goto(joinUrl.toString());
      await expect(page.locator(".room-mobile")).toBeVisible();
      await expect(page.getByRole("heading", { name: mobileText.connected })).toBeVisible();

      await desktopPage.getByLabel(desktopText.diagnostics).click();
      const desktopDiagnostics = desktopPage.getByRole("dialog");

      await expect(desktopDiagnostics).toBeVisible();
      await expect(desktopDiagnostics.getByText("lft-resume-v1", { exact: true })).toBeVisible();
      await desktopDiagnostics.getByRole("button", { name: desktopText.copyDiagnostics }).click();
      await expect(desktopDiagnostics.getByRole("button", { name: desktopText.copied })).toBeVisible();
      await desktopPage.keyboard.press("Escape");
      await expect(desktopDiagnostics).toBeHidden();

      await page.getByLabel(mobileText.diagnostics).click();
      const mobileDiagnostics = page.getByRole("dialog");

      await expect(mobileDiagnostics).toBeVisible();
      await expect(mobileDiagnostics.getByText("lft-resume-v1", { exact: true })).toBeVisible();
      await mobileDiagnostics.getByRole("button", { name: mobileText.copyDiagnostics }).click();
      await expect(mobileDiagnostics.getByRole("button", { name: mobileText.copied })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(mobileDiagnostics).toBeHidden();

      for (const control of [
         page.getByTestId("shared-text-open"),
         page.getByLabel(mobileText.diagnostics),
         page.getByLabel(testInfo.project.name === "iphone-webkit" ? "ルームを更新" : "Refresh room")
      ]) {
         const box = await control.boundingBox();

         expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
         expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }

      await page.keyboard.press("Tab");
      const focused = page.locator(":focus");

      await expect(focused).toBeVisible();
      expect(
         await focused.evaluate((element) => parseFloat(getComputedStyle(element).outlineWidth))
      ).toBeGreaterThanOrEqual(2);
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
         await page.getByLabel(mobileText.diagnostics).evaluate(
            (element) => parseFloat(getComputedStyle(element).transitionDuration)
         )
      ).toBeLessThanOrEqual(0.001);

      const desktopSharedOpen = desktopPage.getByTestId("shared-text-open");
      const mobileSharedOpen = page.getByTestId("shared-text-open");
      const desktopNote = "Desktop to mobile 日本語🙂 <img src=x onerror=globalThis.__lftTextExecuted=1>";
      const mobileNote = "Mobile to desktop مرحبا\nsecond line";

      await desktopSharedOpen.click();
      const desktopSharedDialog = desktopPage.getByRole("dialog");
      const desktopSharedInput = desktopSharedDialog.getByTestId("shared-text-input");

      await expect(desktopSharedInput).toBeEnabled();
      await desktopSharedInput.fill(desktopNote);
      await desktopSharedInput.dispatchEvent("compositionstart");
      await expect(desktopSharedDialog.getByTestId("shared-text-share")).toBeDisabled();
      await desktopSharedInput.dispatchEvent("compositionend");
      await expect(desktopSharedDialog.getByTestId("shared-text-share")).toBeEnabled();
      await desktopSharedDialog.getByTestId("shared-text-share").click();
      await expect(desktopSharedDialog.getByTestId("shared-text-share")).toBeDisabled();
      expect(await desktopPage.evaluate(() => (globalThis as { __lftTextExecuted?: number }).__lftTextExecuted)).toBeUndefined();
      await desktopPage.keyboard.press("Escape");

      await mobileSharedOpen.click();
      const mobileSharedDialog = page.getByRole("dialog");
      const mobileSharedInput = mobileSharedDialog.getByTestId("shared-text-input");

      await expect(mobileSharedInput).toHaveValue(desktopNote);
      expect(await page.evaluate(() => (globalThis as { __lftTextExecuted?: number }).__lftTextExecuted)).toBeUndefined();
      await mobileSharedInput.fill(mobileNote);
      await mobileSharedDialog.getByTestId("shared-text-share").click();
      await expect(mobileSharedDialog.getByTestId("shared-text-share")).toBeDisabled();
      await page.keyboard.press("Escape");

      await expect(desktopPage.locator(".shared-text-unread")).toBeVisible();
      await desktopSharedOpen.click();
      await expect(desktopSharedInput).toHaveValue(mobileNote);
      await mobileSharedOpen.click();
      await expect(mobileSharedInput).toHaveValue(mobileNote);

      const desktopDraft = "Desktop draft wins after explicit conflict confirmation";
      const mobileConcurrent = "Mobile concurrent update";

      await desktopSharedInput.fill(desktopDraft);
      await mobileSharedInput.fill(mobileConcurrent);
      await mobileSharedDialog.getByTestId("shared-text-share").click();
      await expect(mobileSharedDialog.getByTestId("shared-text-share")).toBeDisabled();
      await expect(desktopSharedDialog.getByTestId("shared-text-replace")).toBeVisible();
      await expect(desktopSharedInput).toHaveValue(desktopDraft);
      await desktopSharedDialog.getByTestId("shared-text-replace").click();
      await expect(desktopSharedDialog.getByTestId("shared-text-replace")).toBeHidden();
      await expect(desktopSharedDialog.getByTestId("shared-text-share")).toBeDisabled();
      await expect(mobileSharedInput).toHaveValue(desktopDraft);
      const desktopSharedScreenshot = testInfo.outputPath("desktop-shared-text.png");
      const mobileSharedScreenshot = testInfo.outputPath("mobile-shared-text.png");

      await desktopPage.screenshot({ path: desktopSharedScreenshot });
      await page.screenshot({ path: mobileSharedScreenshot });
      await testInfo.attach("desktop shared text", {
         contentType: "image/png",
         path: desktopSharedScreenshot
      });
      await testInfo.attach("mobile shared text", {
         contentType: "image/png",
         path: mobileSharedScreenshot
      });
      await desktopPage.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      await page.reload();
      await expect(page.getByRole("heading", { name: mobileText.connected })).toBeVisible();
      await page.getByTestId("shared-text-open").click();
      await expect(page.getByTestId("shared-text-input")).toHaveValue(desktopDraft);
      await page.keyboard.press("Escape");

      const desktopInput = desktopPage.locator(".room-tools input[type=file]");
      const heights: number[] = [];

      for (const [index, fixture] of outbound.entries()) {
         await desktopInput.setInputFiles(fixture.path);
         await expect(desktopPage.locator(".room-item")).toHaveCount(index + 1);
         await expect(page.locator(".room-item")).toHaveCount(index + 1);
         await desktopPage.waitForTimeout(150);
         heights.push((await contentSize(electronApp))[1]);
      }

      const [oneItemHeight, twoItemHeight, threeItemHeight, fourItemHeight] = heights;

      if (
         oneItemHeight === undefined
         || twoItemHeight === undefined
         || threeItemHeight === undefined
         || fourItemHeight === undefined
      ) {
         throw new Error("Desktop height samples are incomplete");
      }

      expect(twoItemHeight).toBeGreaterThan(oneItemHeight);
      expect(threeItemHeight).toBeGreaterThan(twoItemHeight);
      expect(Math.abs(fourItemHeight - threeItemHeight)).toBeLessThanOrEqual(4);

      const layout = await desktopPage.evaluate(() => {
         const queue = document.querySelector<HTMLElement>(".room-queue");
         const qr = document.querySelector<HTMLElement>(".room-qr-square");
         const svg = document.querySelector<SVGSVGElement>(".room-qr-square svg");

         if (!queue || !qr || !svg) {
            throw new Error("Room layout is incomplete");
         }

         const qrBounds = qr.getBoundingClientRect();

         return {
            documentClientHeight: document.documentElement.clientHeight,
            documentScrollHeight: document.documentElement.scrollHeight,
            documentClientWidth: document.documentElement.clientWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            overflowY: getComputedStyle(queue).overflowY,
            queueClientHeight: queue.clientHeight,
            queueScrollHeight: queue.scrollHeight,
            qrHeight: qrBounds.height,
            qrWidth: qrBounds.width,
            svgTagName: svg.tagName
         };
      });
      const finalContentSize = await contentSize(electronApp);

      expect(finalContentSize[0]).toBe(300);
      expect(Math.abs(layout.qrWidth - layout.qrHeight)).toBeLessThanOrEqual(1);
      expect(layout.svgTagName.toLowerCase()).toBe("svg");
      expect(layout.queueScrollHeight).toBeGreaterThan(layout.queueClientHeight);
      expect(layout.overflowY).toBe("auto");
      expect(layout.documentScrollHeight).toBeLessThanOrEqual(layout.documentClientHeight + 1);
      expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.documentClientWidth + 1);

      const archivePromise = page.waitForEvent("download");
      const downloadAllLink = page.getByRole("link", {
         name: mobileText.downloadAll(outbound.length)
      });
      const downloadAllBox = await downloadAllLink.boundingBox();

      expect(downloadAllBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      await downloadAllLink.click();
      const archiveDownload = await archivePromise;
      const archivePath = await archiveDownload.path();

      expect(archiveDownload.suggestedFilename()).toBe("Local File Transfer.zip");
      expect(archivePath).not.toBeNull();
      const archiveBytes = await readFile(archivePath as string);

      expect(archiveBytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      for (const fixture of outbound) {
         expect(archiveBytes.includes(Buffer.from(fixture.name, "utf8"))).toBe(true);
      }

      const firstOutbound = outbound[0];

      if (!firstOutbound) {
         throw new Error("Outbound fixture is missing");
      }

      const downloadPromise = page.waitForEvent("download");

      await page.getByLabel(mobileText.downloadFile(firstOutbound.name)).click();
      const download = await downloadPromise;
      const downloadedPath = await download.path();

      expect(downloadedPath).not.toBeNull();
      expect(await readFile(downloadedPath as string)).toEqual(firstOutbound.content);

      const mobileInput = page.locator(".room-file-picker input[type=file]");
      let patchRequests = 0;
      let releaseCheckpoint = (): void => {};
      const checkpointGate = new Promise<void>((resolvePromise) => {
         releaseCheckpoint = resolvePromise;
      });
      const uploadRoute = "**/api/v2/rooms/*/uploads/*";

      await page.route(uploadRoute, async (route) => {
         if (route.request().method() === "PATCH") {
            patchRequests += 1;

            if (patchRequests === 2) {
               await checkpointGate;
            }
         }

         await route.continue().catch(() => undefined);
      });
      await mobileInput.setInputFiles(inbound.map((fixture) => fixture.path));
      const uploadButton = page.getByRole("button", { name: mobileText.upload(inbound.length) });

      await expect(uploadButton).toBeVisible();
      await uploadButton.click();
      await expect.poll(() => patchRequests, {
         timeout: 60_000
      }).toBeGreaterThanOrEqual(2);

      const pauseButton = page.getByRole("button", { name: mobileText.pause });

      await expect(pauseButton).toBeVisible();
      await pauseButton.click();
      releaseCheckpoint();

      const resumeButton = page.getByRole("button", { name: mobileText.resume });

      await expect(resumeButton).toBeVisible({ timeout: 30_000 });
      await resumeButton.click();
      await expect(uploadButton).toBeHidden({ timeout: 150_000 });
      await page.unroute(uploadRoute);
      await expect(desktopPage.locator(".room-item")).toHaveCount(outbound.length + inbound.length);

      for (const fixture of inbound) {
         const receivedPath = join(receiveDir, fixture.name);

         await expect.poll(async () => fileSize(receivedPath), {
            timeout: 150_000
         }).toBe(fixture.content.byteLength);
         expect(sha256(await readFile(receivedPath))).toBe(sha256(fixture.content));
      }

      const desktopScreenshot = testInfo.outputPath("desktop-room.png");
      const mobileScreenshot = testInfo.outputPath("mobile-room.png");

      await desktopPage.screenshot({
         path: desktopScreenshot
      });
      await page.screenshot({
         fullPage: true,
         path: mobileScreenshot
      });
      await testInfo.attach("desktop room", {
         contentType: "image/png",
         path: desktopScreenshot
      });
      await testInfo.attach("mobile room", {
         contentType: "image/png",
         path: mobileScreenshot
      });
   } finally {
      await electronApp?.close().catch(() => undefined);
      await rm(runRoot, {
         force: true,
         recursive: true
      });
   }
});

async function ensureLocalElectron(): Promise<string> {
   const packageJson = JSON.parse(
      await readFile(join(electronPackageRoot, "package.json"), "utf8")
   ) as { version: string };
   const cacheRoot = join(tmpdir(), `local-file-transfer-e2e-electron-${packageJson.version}`);
   const runtimeRoot = join(cacheRoot, "dist");
   const executablePath = join(runtimeRoot, "electron.exe");

   try {
      await access(executablePath);
   } catch {
      await mkdir(cacheRoot, { recursive: true });
      await rm(runtimeRoot, {
         force: true,
         recursive: true
      });
      await cp(join(electronPackageRoot, "dist"), runtimeRoot, {
         force: true,
         recursive: true
      });
   }

   return executablePath;
}

async function contentSize(app: ElectronApplication): Promise<[number, number]> {
   return app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];

      return window ? window.getContentSize() : [0, 0];
   }) as Promise<[number, number]>;
}

async function createOutboundFixtures(directory: string): Promise<Array<{
   name: string;
   path: string;
   content: Buffer;
}>> {
   const fixtures = [
      ["outbound-one.txt", Buffer.from("Local File Transfer outbound one\n")],
      ["outbound-two.bin", Buffer.alloc(5_123, 0x22)],
      ["outbound-three.bin", Buffer.alloc(8_321, 0x33)],
      ["outbound-four.bin", Buffer.alloc(13_579, 0x44)]
   ] as const;

   return Promise.all(fixtures.map(async ([name, content]) => {
      const path = join(directory, name);

      await writeFile(path, content);
      return {
         name,
         path,
         content
      };
   }));
}

async function createInboundFixtures(directory: string): Promise<Array<{
   name: string;
   path: string;
   content: Buffer;
}>> {
   const largePhoto = Buffer.alloc((15 * 1024 * 1024) + 137, 0x6a);

   largePhoto[0] = 0xff;
   largePhoto[1] = 0xd8;
   largePhoto[largePhoto.byteLength - 2] = 0xff;
   largePhoto[largePhoto.byteLength - 1] = 0xd9;

   const fixtures = [
      ["iphone-photo-15mb.jpeg", largePhoto],
      ["mobile-note.txt", Buffer.from("second mobile file\n")]
   ] as const;

   return Promise.all(fixtures.map(async ([name, content]) => {
      const path = join(directory, name);

      await writeFile(path, content);
      return {
         name,
         path,
         content
      };
   }));
}

async function fileSize(path: string): Promise<number> {
   try {
      return (await stat(path)).size;
   } catch {
      return -1;
   }
}

function sha256(value: Uint8Array): string {
   return createHash("sha256").update(value).digest("hex");
}
