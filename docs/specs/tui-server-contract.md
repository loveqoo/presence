# TUI-서버 계약 정책

## 목적

TUI(`@presence/tui`)가 서버(`@presence/server`)와 주고받는 공개 계약을 단일 진원으로 기술한다.
부팅 순서, REST 사용 범위, WebSocket 프로토콜, 세션 전환 순서만 다룬다.
TUI 내부 렌더링/UX 구현은 이 스펙의 대상이 아니다.

## 불변식 (Invariants)

**부팅/인증**

- I1. **부팅 순서**: `resolveServerUrl` → `GET /api/instance`(authRequired 확인) → authRequired=true이면 `loginFlow` → `runRemote`. 서버에 도달하지 못하면 즉시 exit(1).
- I2. **토큰 보관 위치**: 로그인 성공 응답의 `accessToken`은 `authState` 객체에 in-memory 보관. `refreshToken`은 서버가 HttpOnly 쿠키로 발급하며, 응답 body의 `refreshToken` 필드는 있을 수도 없을 수도 있다(`|| null`). 두 값 모두 외부 스토리지(파일/localStorage)에 저장하지 않는다.
- I3. **mustChangePassword 강제**: 로그인 응답에 `mustChangePassword: true`가 포함되면 `POST /api/auth/change-password` 성공 전까지 TUI는 다른 API를 호출하지 않는다. 서버 측에서도 동일 조건으로 403을 반환하는 이중 방어. 최대 3회 입력 실패 시 exit(1).

**REST 사용**

- I4. **TUI가 사용하는 REST 엔드포인트 목록**:
  - `GET  /api/instance` — 서버 생존 확인, authRequired 조회
  - `POST /api/auth/login` — 로그인
  - `POST /api/auth/change-password` — 비밀번호 변경 (mustChangePassword 플로우)
  - `POST /api/auth/refresh` — access token 갱신
  - `GET  /api/sessions` — 세션 목록 조회
  - `POST /api/sessions` — 세션 생성
  - `DELETE /api/sessions/:id` — 세션 삭제
  - `GET  /api/sessions/:id/tools` — 세션 도구 목록
  - `GET  /api/sessions/:id/agents` — 세션 에이전트 목록
  - `GET  /api/sessions/:id/config` — 세션 설정 조회
  - `POST /api/sessions/:id/chat` — 사용자 입력 전송
  - `POST /api/sessions/:id/approve` — 승인/거절 응답
  - `POST /api/sessions/:id/cancel` — 처리 취소
  각 엔드포인트의 의미는 `session.md`, `auth.md`에 위임한다.
- I5. **401 자동 refresh**: HTTP 클라이언트(`createAuthClient`)는 401 응답 시 `authState`가 있고 refresh 토큰이 유효하면 `POST /api/auth/refresh` 1회 시도 후 원래 요청을 재시도한다. refresh 실패 또는 `authState` 부재 시 401 응답 body가 호출자에게 전달됨 (재로그인 자동 유도 미구현 — Known Gap). 동시 다발 401 요청은 단일 refreshPromise로 직렬화(`createTokenRefresher`의 Promise 단일화).

**WebSocket 프로토콜**

- I6. **WS 연결 인증**: `createMirrorState` 호출 시 `authState.accessToken`이 있으면 `Authorization: Bearer <token>` 헤더를 포함해 WebSocket upgrade 요청을 보낸다. 서버의 WS 인증 3단계 폴백(헤더 → query param → 쿠키) 중 TUI는 헤더 방식만 사용한다.
- I7. **WS 메시지 시퀀스**: 연결(`open`) 즉시 클라이언트가 `{ type: 'join', session_id: <sessionId> }`를 전송한다. 서버는 순서대로 `{ type: 'init', session_id, state: <snapshot> }` → `{ type: 'state', session_id, path, value }` (변경 발생 시마다)를 push한다.
- I8. **MirrorState 구독 경로**: `MirrorState.applySnapshot()`은 `SNAPSHOT_PATHS`에 정의된 경로(turnState, lastTurn, turn, context.memories, context.conversationHistory, _streaming, _retry, _approve, _debug.*, _budgetWarning, _toolResults, todos, events, delegates)만 local cache에 반영한다. 그 외 경로는 수신해도 무시한다.
- I10. **WS close 코드 분기 처리**: `MirrorState.handleClose(code)`는 close 코드에 따라 세 가지 경로로 분기한다.
  - `4002`(`PASSWORD_CHANGE_REQUIRED`) / `4003`(`ORIGIN_NOT_ALLOWED`): 재연결 즉시 중단 + `onUnrecoverable(code)` 콜백 호출.
  - `4001`(`AUTH_FAILED`): `onAuthFailed()` 콜백으로 토큰 갱신 1회 시도. 성공 시 즉시 재연결, 실패 시 `onUnrecoverable(code)` 호출 후 중단.
  - 그 외: 기존 지수 백오프(최소 500ms, 최대 15,000ms) 재연결.
  콜백은 `RemoteSession` 생성자가 `tryRefresh`를 받아 `MirrorState`에 주입한다.
- I11. **WS 재연결 시 최신 토큰 사용**: `MirrorState.connect()`는 매번 `getHeaders()` 콜백을 호출하여 최신 Authorization 헤더를 사용한다. `onAuthFailed` 성공 후 갱신된 access token이 다음 재연결에 자동 반영된다.

**세션 전환**

- I9. **switchSession 순서**: `MirrorState.disconnect()` → `currentSessionId` 갱신 → `createMirrorState(newId)` (새 WS 연결) → `GET /api/sessions/:newId/tools` → App 재렌더. tools 조회 실패 시 이전 tools를 유지한다.

## 경계 조건 (Edge Cases)

- E1. **WS close 코드 분기 처리 (해소됨)**: I10으로 불변식 승격. `MirrorState.handleClose(code)`가 4001/4002/4003을 구분하여 처리한다.
- E2. **WS 재연결 시 토큰 갱신 없음 (해소됨)**: I11으로 불변식 승격. `getHeaders()` 콜백으로 매 재연결 시 최신 토큰 사용, `onAuthFailed` 성공 후 갱신 토큰 자동 반영.
- E3. **`/api/auth/status` 멀티유저 한계**: `checkServer`가 호출하는 `/api/instance`는 `authRequired` 여부만 반환한다. `auth.md E10` 참조 — `/api/auth/status`는 첫 번째 등록 유저만 노출하므로, 멀티유저 환경에서 TUI가 현재 로그인한 유저를 서버에서 역조회하는 경로는 없다.
- E4. **authRequired=false 분기 미도달 (Known Gap)**: `main.js`의 `serverStatus.authRequired ? loginFlow() : { authState: null, username: null }` 분기에서 `false` 경로는 `auth.md I2`에 의해 `authEnabled`가 `true`로 하드코딩되어 있으므로 운영 환경에서 도달하지 않는다. 이 분기를 활성화하는 설정 경로가 없으므로 사실상 dead code다.

## 테스트 커버리지

- I1, I3 → `packages/server/test/server.test.js` (부팅 플로우, mustChangePassword WS 4002)
- I5 → (직접 테스트 없음) ⚠️ createAuthClient의 refresh 재시도 로직 단위 테스트 없음
- I7 → `packages/server/test/server.test.js` (join/init/state 시퀀스)
- I9 → (직접 테스트 없음) ⚠️ switchSession 순서 검증 테스트 없음
- I10, I11 → (직접 테스트 없음) ⚠️ MirrorState close 코드 분기 및 getHeaders 콜백 단위 테스트 없음

## 관련 코드

- `packages/tui/src/main.js` — 부팅 순서, loginFlow, changePasswordFlow, resolveServerUrl
- `packages/tui/src/remote.js` — RemoteSession, createAuthClient, createTokenRefresher, runRemote, switchSession
- `packages/tui/src/http.js` — jsonRequest, checkServer, loginToServer, changePasswordOnServer, refreshAccessToken
- `packages/infra/src/infra/states/mirror-state.js` — MirrorState, SNAPSHOT_PATHS, connect, applySnapshot, applyPatch

## 변경 이력

- 2026-04-10: 초기 작성
- 2026-04-10: I5 정정 — "재로그인 유도" 미구현 사실 반영, authState 부재 시 즉시 401 body 반환 동작 명시 (Known Gap).
- 2026-04-10: E1/E2 Known Gap 해소 — I10(WS close 코드 분기), I11(재연결 시 최신 토큰) 으로 불변식 승격. MirrorState getHeaders/onAuthFailed/onUnrecoverable 콜백 구조 명시. 관련 코드에 remote.js 주석 갱신.
