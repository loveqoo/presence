# 서버/WebSocket 통신 정책

## 목적

presence 서버의 Express HTTP 파이프라인, WebSocket 인증 플로우, 세션 state broadcast 규칙을 정의한다. 인증 미들웨어 순서와 WS 프로토콜은 불변이며, 변경 시 전체 인증 체계에 영향을 준다.

## Express 파이프라인 (순서 불변)

```
1. Cookie parser
2. Public auth routes    → POST /api/auth/login, /refresh, /logout, GET /api/auth/status
3. Auth middleware        → /api/** (JWT 검증)
4. Protected auth routes → POST /api/auth/change-password
5. Activity tracking     → /api/** (touch UserContext)
6. Health endpoint       → GET /api/instance
7. Session API           → /api/sessions/**
8. Static web UI         → catch-all (마지막)
```

## WebSocket 프로토콜 (메시지 흐름)

```
클라이언트                              서버
    |                                   |
    |--- WS upgrade (token/cookie) ---> |  (인증 검증)
    |                                   |
    |--- { type: 'join',              --|  (세션 조회/생성)
    |      session_id: '...' }          |
    |                                   |
    |<-- { type: 'init',             ---|  (세션 초기 상태)
    |      session_id: '...',           |
    |      state: {...} }               |
    |                                   |
    |<-- { type: 'state',            ---|  (상태 변경 push)
    |      session_id: '...',           |
    |      path: '...',                 |
    |      value: ... }                 |
```

## 불변식 (Invariants)

- I1. **파이프라인 순서**: `#mountRoutes`의 미들웨어 등록 순서가 곧 파이프라인. cookie parser → public auth → auth middleware → protected auth → activity → health → session API → static. 이 순서를 변경하면 인증이 깨진다.
- I2. **Public 경로 예외**: `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/status`, `/api/instance`는 auth middleware 적용 전에 등록. 토큰 없이도 접근 가능. (`auth-setup.js:28` `publicPaths` 목록에 `/instance` 포함)
- I3. **WS join 전 데이터 없음**: WS 연결 직후 클라이언트가 `type: 'join'` 메시지를 보내기 전까지는 서버가 해당 세션에 대한 데이터를 전송하지 않는다.
- I4. **state broadcast는 WATCHED_PATHS만**: SessionBridge는 `constants.js`의 `WATCHED_PATHS`에 정의된 경로의 state 변경만 broadcast한다. 전체 snapshot을 매번 전송하지 않는다. `WATCHED_PATHS` 정의 경로만 변경 broadcast. `_debug.iterationHistory`는 `STATE_PATH.DEBUG_ITERATION_HISTORY`로 WATCHED_PATHS에 포함되어 변경 시 broadcast된다. watchSession 대상: `SCHEDULED` 세션 제외, `USER`/`AGENT` 포함 (`index.js:128`, `user-context-manager.js:34`). 에이전트 세션의 진행 상태도 WS 클라이언트에 broadcast된다.
- I5. **WS 인증 실패 즉시 close**: 인증 실패 시 `ws.close(code, message)` 즉시 호출. 연결 유지 없음. 코드: 4001(인증 실패), 4002(비밀번호 변경 필요), 4003(origin 불허).
- I6. **UserContextManager 지연 생성**: 인증된 유저의 첫 REST 요청 또는 WS join 시 해당 유저의 UserContext를 생성 (`getOrCreate`). 서버 시작 시 전체 유저의 UserContext를 미리 생성하지 않는다. 운영 환경은 `authEnabled=true` 고정이므로 모든 요청이 `UserContextManager` 경유로 유저별 `UserContext`를 사용한다. 단일 `#userContext` 필드는 테스트/레거시 브릿지 목적의 폴백 경로다.
- I7. **WS 연결 해제 후 비활성 타임아웃**: 유저의 모든 WS 연결이 끊기면 `INACTIVITY_TIMEOUT_MS` (30분, `30 * 60 * 1000` ms — `packages/server/src/server/constants.js`) 후 UserContext 자동 shutdown. 새 연결 도달 시 타이머 취소.
- I8. **세션 소유권 WS에서도 강제**: WS `join` 처리 시에도 `entry.owner !== wsUsername` 조건으로 403 에러 메시지 전송. join 취소.
- I9. **origin 검증 — REST와 WS 두 경로**: (1) REST/CORS: `corsMiddleware`는 origin hostname이 `localhost` 또는 `127.0.0.1`인 경우만 Access-Control 헤더 추가. 다른 origin은 헤더 없음. (2) WS `#checkOrigin`: `localhost`/`127.0.0.1`에 더해 생성자에서 주입된 `this.#host`(기본값 `127.0.0.1`)도 추가 허용. WS 쪽이 서버 리슨 주소(`opts.host`)를 추가 허용하는 이유는 동적 바인딩 호스트에서도 같은 머신 내 클라이언트 접근을 허용하기 위함이다.
- I10. **서버 shutdown 순서**: SIGTERM/SIGINT → scheduler stop → UserContext.shutdown() → UserContextManager.shutdownAll() → wss.close() → httpServer.close().
- I11. **유저 활동 touch 다중 호출**: activity 미들웨어(step 5, `index.js:188`)와 `resolveUserContext`(`session-api.js:175`)와 WS connection 시(`ws-handler.js:80`) 양쪽에서 `touch()` 호출. 중복이나 무해 — 타임아웃 재설정만 수행.

## WS Close 코드

| 코드 | 상수명 | 의미 |
|------|--------|------|
| 4001 | `AUTH_FAILED` | 인증 실패 (토큰 무효/만료) |
| 4002 | `PASSWORD_CHANGE_REQUIRED` | 비밀번호 변경 필요 |
| 4003 | `ORIGIN_NOT_ALLOWED` | CSRF / Origin not allowed |

## 알려진 한계 (Known Limitations)

- L1. **broadcast 격리 없음**: `SessionBridge.broadcast()`는 `wss.clients` 전체에 메시지를 전송한다. 세션별 구독 필터링이 없으므로, 연결된 모든 클라이언트가 모든 세션의 state 변경을 수신한다. 클라이언트가 `session_id` 필드로 자신의 세션 메시지를 필터링할 책임을 진다. 서버 측 구독 격리는 미구현 상태다.

## 경계 조건 (Edge Cases)

- E1. WS 연결 후 `join` 없이 다른 메시지 전송 → 무시 (type !== 'join' 조건).
- E2. `join`에 존재하지 않는 `session_id` → `findOrCreateSession`에서 null 반환 → join 응답 없음 (클라이언트에게 명시적 에러 없음). ⚠️ 개선 여지
- E3. auth middleware가 등록되기 전에 session API가 마운트될 경우 → 인증 없이 모든 세션 접근 가능 (파이프라인 순서 위반). I1이 이를 방지.
- E4. UserContextManager.getOrCreate()가 동시에 같은 username으로 호출 → `#pending` Map 기반 single-flight으로 차단됨 (A2A S4 해소). 첫 번째 호출이 Promise를 `#pending`에 등록하고 동시 호출은 같은 Promise를 반환한다. `UserContext.create` + recovery가 두 번 실행되지 않음이 보장된다. `session.md I16 UserContextManager single-flight 불변식` 참조.
- E5. shutdown 중 새 HTTP 요청 도달 → `httpServer.close()` 후 새 연결 거부. 이미 처리 중인 요청은 완료 허용.
- E6. WS broadcast 시 CLOSED 상태 클라이언트 존재 → `ws.readyState === 1` (OPEN) 조건으로 필터링. 에러 없음.
- E7. `/api/instance` health endpoint는 `publicPaths`에 포함되어 토큰 없이 접근 가능. 테스트 AE11 (`packages/server/test/auth-e2e.test.js`) 이 미인증 200 응답을 검증.
- E8. Static web UI `dist/` 디렉토리 없는 경우 → catch-all 라우트 미등록. API만 동작.
- E9. **유저 A의 세션 state 변경이 유저 B의 클라이언트에 broadcast 가능**: SessionBridge.broadcast()가 wss.clients 전체 대상이므로, 유저 A의 세션이 변경되면 유저 B의 연결된 WS에도 전송된다. 클라이언트가 세션 ID로 필터링해야 한다. L1 참조.

## 테스트 커버리지

- I1 → `packages/server/test/server.test.js` (파이프라인 순서 통합 테스트)
- I2 → `packages/server/test/auth-e2e.test.js` (public auth 경로 미인증 접근)
- I3 → `packages/server/test/server.test.js` (WS join 전 상태 없음)
- I5 → `packages/server/test/server.test.js` (WS 4001/4002/4003)
- I8 → `packages/server/test/server.test.js` (WS join 소유권 에러)
- I7 → `packages/server/test/server.test.js` (비활성 타임아웃)
- E2 → (미커버) ⚠️ join 후 응답 없음 케이스 테스트 없음
- E4 → `packages/server/src/server/user-context-manager.js` `#pending` Map 구현 (코드 레벨 단일 진원). 동시 호출 시나리오 단위 테스트 없음 ⚠️
- E7 → `packages/server/test/auth-e2e.test.js` AE11 (미인증 /api/instance 200 검증)

## 관련 코드

- `packages/server/src/server/index.js` — PresenceServer, `#mountRoutes`, shutdown 순서
- `packages/server/src/server/ws-handler.js` — SessionBridge, WsHandler
- `packages/server/src/server/user-context-manager.js` — UserContextManager (지연 생성, 타임아웃)
- `packages/server/src/server/auth-setup.js` — Express 미들웨어/라우터 조립
- `packages/server/src/server/constants.js` — WS_CLOSE, INACTIVITY_TIMEOUT_MS, WATCHED_PATHS
- `packages/server/src/server/session-api.js` — Session REST API

## 변경 이력

- 2026-04-10: 초기 작성
- 2026-04-10: I4a 추가 — broadcast 대상이 wss.clients 전체임을 명시, E9 추가 — 멀티유저 broadcast 격리 문제
- 2026-04-10: I4a를 불변식 섹션에서 제거하고 "알려진 한계(L1)"으로 이동. E9의 참조도 L1으로 갱신. 클라이언트 필터링 책임 명시.
- 2026-04-10: I5 및 WS Close 코드 테이블 정정 — constants.js 실제 값과 일치하도록 수정 (4001=AUTH_FAILED, 4002=PASSWORD_CHANGE_REQUIRED, 4003=ORIGIN_NOT_ALLOWED). 테이블에 상수명 컬럼 추가.
- 2026-04-10: I2에 `/api/instance` 추가 — auth-setup.js:28 publicPaths 목록 반영. E7 정정 — 인증 필요에서 public 경로(토큰 불필요)로 수정, AE11 테스트 커버리지 연결.
- 2026-04-10: I7 INACTIVITY_TIMEOUT_MS 실제 값 명시 — 30분(`30 * 60 * 1000` ms), 상수 정의 위치(constants.js:13) 기재.
- 2026-04-10: I9 WS #checkOrigin 추가 — CORS 미들웨어(localhost/127.0.0.1만) 기술에서 REST와 WS 두 경로로 분리. WS 쪽은 this.#host(opts.host) 추가 허용 명시 (ws-handler.js:103).
- 2026-04-10: I6에 authEnabled 고정 + #userContext 폴백 경로 명시 — 운영은 항상 UserContextManager 경유, 단일 #userContext는 테스트/레거시 전용.
- 2026-04-10: I4에 `_debug.iterationHistory` WATCHED_PATHS 미포함 명시 — 초기 snapshot만 전달, 이후 변경 broadcast 없음. I11 추가 — activity touch 3곳 호출(미들웨어/resolveUserContext/WS connection) 명시.
- 2026-04-10: I4에 watchSession 세션 유형 필터 추가 — SCHEDULED 제외, USER/AGENT 포함 명시.
- 2026-04-10: I4 `_debug.iterationHistory` WATCHED_PATHS 포함 확인 — STATE_PATH.DEBUG_ITERATION_HISTORY 추가됨, "미포함 개선 여지" 표기 제거.
- 2026-04-25: E4 갱신 — A2A Phase 1 S4에서 UserContextManager.getOrCreate()에 `#pending` single-flight 보호 추가로 경합 조건 해소. 알려진 한계 제거.
