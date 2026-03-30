import { defineConfig } from '@playwright/test'

// Vite dev 서버를 경유하는 실제 LLM e2e 테스트.
// 유저가 실제로 사용하는 경로를 그대로 통과:
//   Vite(5173) → 인증 → 서버 직접 연결
//
// 사전 조건:
//   npm start (서버 실행)
//
// 사용법:
//   npm start
//   cd packages/web && npx playwright test --config=playwright.live.config.js

const serverURL = process.env.SERVER_URL || 'http://127.0.0.1:3000'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'live.spec.js',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: `SERVER_URL=${serverURL} npx vite`,
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30000,
  },
})
