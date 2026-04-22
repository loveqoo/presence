# @presence/server

Express + WebSocket 서버. 1 서버 = N 유저.

## 구조

```
src/server/
├── index.js                  ← PresenceServer facade (static create, shutdown)
├── constants.js              ← 서버 도메인 상수 (WS_CLOSE, INACTIVITY_TIMEOUT_MS, WATCHED_PATHS)
├── auth-setup.js             ← Auth 미들웨어/라우터 반환 (createAuthSetup)
├── session-api.js            ← Session Router + 슬래시 커맨드 테이블 디스패치
├── ws-handler.js             ← SessionBridge + WsHandler (WS 계층 통합)
└── user-context-manager.js   ← UserContextManager (유저별 생명주기)
```

### PresenceServer

서버의 조립 facade. `static async create(config, opts)` → `#boot()` → `shutdown()`.

- `#mountRoutes(auth, ctx)` — Express 미들웨어/라우트 마운트 순서를 한 곳에서 가시화
- `#createScheduler()` — cron 잡 스케줄러 생성
- `#registerAgentSessions()` — config.agents 기반 서브 에이전트 등록
- `startServer()` — 레거시 브릿지 (테스트 호환 `{ server, wss, app, userContext, shutdown }`)

### Express 파이프라인 (#mountRoutes 순서)

```
1. Cookie parser
2. Public auth routes    → /api/auth (login, refresh, logout, status)
3. Auth middleware        → /api (JWT 검증)
4. Protected auth routes → /api/auth (change-password)
5. Activity tracking     → /api
6. Health endpoint       → /api/instance
7. Session API           → /api/sessions/*
8. Static web UI         → catch-all
```

## 정책

### 사용자 등록

관리자가 CLI로 등록. 셀프 가입 없음.

```bash
npm run user -- init --username <이름>    # 등록 + 임시 비밀번호
npm run user -- add --username <이름>     # 추가 사용자
npm run user -- passwd --username <이름>  # 비밀번호 재설정
npm run user -- list                      # 사용자 목록
```

최초 로그인 시 비밀번호 변경 강제. 변경 전까지 기능 사용 불가.

### 유저 데이터 격리

```
~/.presence/users/{username}/
├── config.json       ← LLM, locale, persona 등
├── memory.json       ← MemoryGraph
├── mem0_history.db   ← mem0 SQLite
├── jobs.db           ← 스케줄러 JobStore
├── sessions/         ← 세션 영속화 (session state.json)
├── agent-policies.json (admin 만) ← user agent quota
├── pending/          ← 승인 대기 (admin 만)
├── approved/         ← 승인 완료 (admin 만)
└── rejected/         ← 거부 (admin 만)
```

다른 머신 이동: 유저 폴더 통째로 복사.

### 인증

- bcrypt 해시 + HMAC-SHA256 JWT (node:crypto)
- Access token (15분) + Refresh token (7일, rotation)
- `POST /api/auth/login`, `/refresh`, `/logout`, `/change-password`

### 횡단 관심사

인증/토큰 변경 시 확인:
- WS, API 모든 경로에서 동작하는가?
- refresh rotation이 다른 클라이언트/테스트에 영향을 주는가?
