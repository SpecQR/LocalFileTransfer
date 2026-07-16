import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
   testDir: "./tests/e2e",
   timeout: 180_000,
   expect: {
      timeout: 30_000
   },
   fullyParallel: false,
   workers: 1,
   retries: 0,
   forbidOnly: true,
   outputDir: "test-results",
   reporter: [
      ["list"],
      ["html", {
         open: "never",
         outputFolder: "playwright-report"
      }]
   ],
   use: {
      screenshot: "only-on-failure",
      trace: "retain-on-failure",
      video: "off"
   },
   projects: [
      {
         name: "android-chromium",
         use: {
            ...devices["Pixel 7"]
         }
      },
      {
         name: "iphone-webkit",
         use: {
            ...devices["iPhone 15"],
            locale: "ja-JP"
         }
      }
   ]
});