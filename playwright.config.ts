import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.e2e.ts",
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5188",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:5188/health",
    timeout: 60000,
    reuseExistingServer: false,
    env: { PORT: "5188", DATA_DIR: ".data/e2e", EXPORT_DIR: "exports/e2e" },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
});
