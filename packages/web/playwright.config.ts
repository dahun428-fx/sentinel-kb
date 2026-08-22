/**
 * Playwright 설정 (T-023 Acceptance 1).
 *
 * `pnpm verify`에서 분리되어 있다 — 브라우저를 띄우는 검사를 머지 게이트에 넣으면
 * 루프가 느려진다. 실행은 `pnpm --filter @sentinel/web test:e2e`.
 *
 * webServer 두 개를 띄운다: 계약을 지키는 core-api 스텁과, 그것을 가리키는 Next 서버.
 * 웹의 데이터 로딩은 서버 컴포넌트에서 일어나므로 브라우저 측 라우팅 목으로는 대체할 수 없다.
 */
import { defineConfig, devices } from "@playwright/test";

import { CANARY_API_KEY, STUB_API_PORT, WEB_PORT } from "./e2e/fixtures";

const BASE_URL = `http://127.0.0.1:${String(WEB_PORT)}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: process.env["CI"] !== undefined,
  retries: process.env["CI"] !== undefined ? 1 : 0,
  reporter: process.env["CI"] !== undefined ? "list" : "line",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm exec tsx e2e/stub-api.ts",
      url: `http://127.0.0.1:${String(STUB_API_PORT)}/health`,
      reuseExistingServer: process.env["CI"] === undefined,
      stdout: "pipe",
    },
    {
      // `--webpack`은 next.config.mjs의 extensionAlias(=contracts 소스 import) 때문에 필요하다.
      command: `pnpm exec next dev --webpack --port ${String(WEB_PORT)}`,
      url: BASE_URL,
      reuseExistingServer: process.env["CI"] === undefined,
      env: {
        CORE_API_URL: `http://127.0.0.1:${String(STUB_API_PORT)}`,
        CORE_API_KEY: CANARY_API_KEY,
      },
      stdout: "pipe",
    },
  ],
});
