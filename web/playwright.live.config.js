import { defineConfig } from '@playwright/test'

// 실제 LLM 서버를 띄운 상태에서 실행하는 e2e 테스트.
// 서버를 직접 시작하지 않으므로 먼저 `node src/server/index.js`를 실행해야 한다.
//
// 사용법:
//   node src/server/index.js &          # 서버 시작 (포트 3000)
//   cd web && npx playwright test --config=playwright.live.config.js

export default defineConfig({
  testDir: './e2e',
  testMatch: 'live.spec.js',
  timeout: 60000,
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:3000',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
})
