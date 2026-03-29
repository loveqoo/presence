import { defineConfig } from '@playwright/test'

// Vite dev 서버를 경유하는 실제 LLM e2e 테스트.
// 유저가 실제로 사용하는 경로를 그대로 통과:
//   Vite(5173) → 인스턴스 선택 → 인증 → 인스턴스 직접 연결
//
// 사전 조건:
//   npm start (오케스트레이터 + 인스턴스 실행)
//
// 사용법:
//   npm start
//   cd packages/web && npx playwright test --config=playwright.live.config.js

const orchestratorURL = process.env.ORCHESTRATOR_URL || 'http://127.0.0.1:3010'

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
    command: `ORCHESTRATOR_URL=${orchestratorURL} npx vite`,
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30000,
  },
})
