# @presence/web — 브라우저 클라이언트

Presence 에이전트 서버와 연결되는 React 웹 UI 패키지입니다.

## 구조

```
packages/web/
├── src/
│   ├── App.jsx          ← 루트 컴포넌트 (WebSocket 연결 + 채팅 UI)
│   ├── components/      ← StatusBar, ChatArea, InputBar 등
│   └── hooks/           ← useAgentState (RemoteState 연동)
├── e2e/
│   ├── chat.spec.js     ← Playwright E2E (mock 서버)
│   ├── live.spec.js     ← Playwright E2E (실제 LLM 서버)
│   └── helpers.js       ← 테스트 헬퍼 (mock LLM + 서버 기동)
├── playwright.config.js         ← mock E2E 설정 (포트 3200)
└── playwright.live.config.js    ← live E2E 설정 (포트 3000)
```

## 실행

### 개발 서버

```bash
# 서버 먼저 실행
node packages/server/src/server/index.js

# 웹 개발 서버 (별도 터미널, 포트 5173)
npm run dev --workspace=@presence/web
```

브라우저에서 `http://localhost:5173` 접속.

### 프로덕션 빌드

```bash
npm run build --workspace=@presence/web
# 빌드 결과: packages/web/dist/
# 서버가 자동으로 dist/ 정적 파일을 서빙함
```

## 서버 연결

웹 클라이언트는 서버와 두 가지 채널로 통신합니다:

| 채널 | 용도 |
|------|------|
| WebSocket (`ws://`) | 서버 상태 실시간 수신 (turnState, turn 카운터 등) |
| REST API (`/api/chat`, `/api/approve` 등) | 입력 전송, 승인/취소 |

서버 URL은 환경 변수 또는 동일 origin으로 자동 감지됩니다.

## E2E 테스트

```bash
# mock LLM 서버 사용 (API 키 불필요)
cd packages/web && npx playwright test

# 실제 LLM 서버 사용 (서버 먼저 실행 필요)
node packages/server/src/server/index.js &
cd packages/web && npx playwright test --config=playwright.live.config.js
```

`node test/run.js` 실행 시 mock E2E 테스트가 자동으로 포함됩니다.
