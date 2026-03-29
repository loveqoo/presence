import { defineConfig } from '@playwright/test'

// 실제 LLM 서버를 띄운 상태에서 실행하는 e2e 테스트.
// 단일 worker, 단일 browser context에서 실행.
//
// 사용법:
//   npm start
//   cd packages/web && npx playwright test --config=playwright.live.config.js

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3001'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'live.spec.js',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL,
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
