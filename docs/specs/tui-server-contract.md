# TUI-서버 계약 정책

## 목적

TUI(`@presence/tui`)가 서버(`@presence/server`)와 주고받는 공개 계약을 단일 진원으로 기술한다.
부팅 순서, REST 사용 범위, WebSocket 프로토콜, 세션 전환 순서만 다룬다.
TUI 내부 렌더링/UX 구현은 이 스펙의 대상이 아니다.

## 불변식 (Invariants)

**부팅/인증**

- I1. **부팅 순서**: `resolveServerUrl` → `GET /api/instance`(authRequired 확인) → authRequired=true이면 `loginFlow` → `runRemote`. 서버에 도달하지 못하면 `checkServer`가 반환한 `reason.code`에 따라 힌트(ECONNREFUSED/ETIMEDOUT/ENOTFOUND별 메시지)를 stderr에 출력한 뒤 exit(1).
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
- I13. **onUnrecoverable 발동 시 UI 상태**: `RemoteSession.#createMirrorState`의 `onUnrecoverable(code)` 콜백이 호출되면 `#disconnected = { code, at: Date.now() }`를 설정하고 App을 rerender한다. App은 `disconnected` prop이 non-null이면 빨간 double-border 배너를 렌더링하고 `InputBar.disabled`를 true로 설정한다. 배너의 사유 문구(`disconnectedReason`)는 close code에 따라 분기된다:
  - `4001` → "세션이 만료되었습니다"
  - `4002` → "비밀번호 변경이 필요합니다"
  - `4003` → "접근이 거부되었습니다"
  - 그 외 → "서버 연결이 끊겼습니다"
  배너 본문: `"⚠ {disconnectedReason} (close {code})."` + `"TUI 를 재시작하세요 (Ctrl+C)."`. `InputBar`에는 `hint` prop으로 i18n 키 `input_hint.disconnected`("연결 끊김 · Ctrl+C로 재시작") 값이 전달된다. 배너 표시는 "복구 불가"(4001 refresh 실패, 4002, 4003) 경로에만 한정된다 — 백오프 재연결 경로에서는 발동하지 않는다.
- I11. **WS 재연결 시 최신 토큰 사용**: `MirrorState.connect()`는 매번 `getHeaders()` 콜백을 호출하여 최신 Authorization 헤더를 사용한다. `onAuthFailed` 성공 후 갱신된 access token이 다음 재연결에 자동 반영된다.

**TUI 진입 stdout 출력**

- I14. **진입 시 stdout 출력 순서**: `main()`은 아래 두 메시지를 stdout에 출력한다 (I1 부팅 순서와 연동).
  1. `resolveServerUrl` 직후: `"연결 중: {url} [{label}]"`. `label`은 URL 결정 근거로 `'arg'` → `"--server"`, `'env'` → `"PRESENCE_SERVER"`, `'default'` → `"기본값"`.
  2. `loginFlow` 완료 후 `runRemote` 호출 직전: `"세션을 초기화하는 중..."`.
  두 메시지는 stderr가 아닌 stdout. 서버 도달 불가(I1 exit 경로) 또는 로그인 실패(exit) 시에는 두 번째 메시지가 출력되지 않는다.
- I15. **비밀번호 입력 에코 금지**: `promptPassword`는 사용자가 입력하는 문자를 터미널에 에코하지 않는다. 길이를 추론할 수 있는 어떤 문자(`*` 포함)도 출력되지 않는다. prompt 문자열 자체는 출력된다.

**세션 전환**

- I9. **switchSession 순서**: `MirrorState.disconnect()` → `currentSessionId` 갱신 → `createMirrorState(newId)` (새 WS 연결) → `GET /api/sessions/:newId/tools` → `#pendingInitialMessages`에 `{ role: 'system', content: t('sessions_cmd.switched', { id }) }` 주입 → App 재렌더. App 재렌더 시 `#buildAppProps()`가 `#consumePendingInitialMessages()`를 한 번 소비하여 `initialMessages` prop으로 전달한다. 소비 후 `#pendingInitialMessages`는 초기화된다. tools 조회 실패 시 이전 tools를 유지한다.

**취소 피드백**

- I16. **cancel 피드백 메시지는 TUI local-only**: Esc 키가 working 상태에서 `POST /api/sessions/:id/cancel`을 유발하면, `App.handleInput`의 `onCancel()` 직후 `addMessage({ role: 'system', content: t('key_hint.cancelled') })`로 피드백 메시지를 ChatArea에 추가한다. 이 메시지는 `conversationHistory`(서버 세션 상태)에 저장되지 않으며, 세션 재접속 시 소멸한다. 승인 결정 기록(`approve.md I4`)과 동일한 ephemeral 특성을 가진다.
- I12. **세션 전환 후 StatusBar 갱신**: `switchSession` 완료 후 App 재렌더 시 `sessionId` prop이 새 세션 ID로 업데이트된다. StatusBar는 이를 받아 `session: {id}` 세그먼트를 갱신한다. `session` 항목은 `DEFAULT_ITEMS`에 포함되므로 기본 표시된다. 서버 세션 모델에 `name` 필드가 없으므로 표시 식별자는 `sessionId` 단일 경로다.

## 경계 조건 (Edge Cases)

- E5. **`_streaming.length` — wire 전송되나 UI 노출 없음**: 서버→TUI로 전송되는 `_streaming` 객체는 `{ status, content, length }` 세 필드를 포함한다. `length`는 스트리밍 누적 바이트 수(내부 지표)이며 TUI UI에 직접 노출하지 않는다. App은 `content` 유무만으로 `thinking...` vs 마크다운 렌더를 결정한다. `length`를 UI 분기 조건으로 사용하거나 화면에 출력하는 것은 계약 위반이다.
- E1. **WS close 코드 분기 처리 (해소됨)**: I10으로 불변식 승격. `MirrorState.handleClose(code)`가 4001/4002/4003을 구분하여 처리한다.
- E2. **WS 재연결 시 토큰 갱신 없음 (해소됨)**: I11으로 불변식 승격. `getHeaders()` 콜백으로 매 재연결 시 최신 토큰 사용, `onAuthFailed` 성공 후 갱신 토큰 자동 반영.
- E3. **`/api/auth/status` 멀티유저 한계**: `checkServer`가 호출하는 `/api/instance`는 `authRequired` 여부만 반환한다. `auth.md E10` 참조 — `/api/auth/status`는 첫 번째 등록 유저만 노출하므로, 멀티유저 환경에서 TUI가 현재 로그인한 유저를 서버에서 역조회하는 경로는 없다.
- E4. **authRequired=false 분기 미도달 (Known Gap)**: `main.js`의 `serverStatus.authRequired ? loginFlow() : { authState: null, username: null }` 분기에서 `false` 경로는 `auth.md I2`에 의해 `authEnabled`가 `true`로 하드코딩되어 있으므로 운영 환경에서 도달하지 않는다. 이 분기를 활성화하는 설정 경로가 없으므로 사실상 dead code다.

## 테스트 커버리지

- I1, I3 → `packages/server/test/server.test.js` (부팅 플로우, mustChangePassword WS 4002)
- I5 → (직접 테스트 없음) ⚠️ createAuthClient의 refresh 재시도 로직 단위 테스트 없음
- I7 → `packages/server/test/server.test.js` (join/init/state 시퀀스)
- I9, I12 → `packages/tui/test/scenarios/session-switch.scenario.js` (FP-14, 전환 후 StatusBar session 세그먼트 표시 검증)
- I9 (switchSession 시스템 메시지 주입) → (직접 테스트 없음) ⚠️ pendingInitialMessages 소비 및 ChatArea 노출 시나리오 테스트 없음 (FP-37)
- E5 → `packages/tui/test/app.test.js` 63b (content 없을 때 "receiving" 미노출, "thinking" 표시 검증)
- I10, I11 → (직접 테스트 없음) ⚠️ MirrorState close 코드 분기 및 getHeaders 콜백 단위 테스트 없음
- I13 → (직접 테스트 없음) ⚠️ onUnrecoverable 발동 시 code별 배너 문구 + InputBar disabled 시나리오 테스트 없음 (FP-22, FP-24)
- I14 → (직접 테스트 없음) ⚠️ 진입 시 stdout 출력 순서(resolveServerUrl 출력, 세션 초기화 출력) 단위 테스트 없음 (FP-17, FP-21)
- I15 → (직접 테스트 없음) ⚠️ promptPassword 에코 억제 단위 테스트 없음 (FP-18)
- I16 → (직접 테스트 없음) ⚠️ Esc 취소 후 system 메시지가 ChatArea에 추가되고 서버 상태에 기록되지 않음을 검증하는 테스트 없음

## 관련 코드

- `packages/tui/src/main.js` — 부팅 순서, loginFlow, changePasswordFlow, resolveServerUrl
- `packages/tui/src/remote.js` — RemoteSession, createAuthClient, createTokenRefresher, runRemote, switchSession
- `packages/tui/src/http.js` — jsonRequest, checkServer, loginToServer, changePasswordOnServer, refreshAccessToken
- `packages/infra/src/infra/states/mirror-state.js` — MirrorState, SNAPSHOT_PATHS, connect, applySnapshot, applyPatch

## 변경 이력

- 2026-04-10: 초기 작성
- 2026-04-10: I5 정정 — "재로그인 유도" 미구현 사실 반영, authState 부재 시 즉시 401 body 반환 동작 명시 (Known Gap).
- 2026-04-10: E1/E2 Known Gap 해소 — I10(WS close 코드 분기), I11(재연결 시 최신 토큰) 으로 불변식 승격. MirrorState getHeaders/onAuthFailed/onUnrecoverable 콜백 구조 명시. 관련 코드에 remote.js 주석 갱신.
- 2026-04-11: FP-14 반영 — I12 추가(세션 전환 후 StatusBar 갱신, sessionId 단일 경로). 서버 세션 모델에 name 필드가 없으므로 sessionName 개념 제외.
- 2026-04-11: FP-16/FP-22 해소 반영 — I1에 checkServer reason.code별 힌트 출력 명시. I13 추가(onUnrecoverable → disconnected 배너 + InputBar disabled). 배너는 복구 불가 경로 전용(백오프 재연결 경로 제외) 명시. 테스트 커버리지에 I13 미커버 추가.
- 2026-04-11: FP-29/FP-30/FP-37 해소 반영 — I13에 InputBar hint prop 전달 명시(input_hint.disconnected). I9에 pendingInitialMessages 주입·소비 계약 추가(세션 전환 시스템 메시지). E5 추가(_streaming.length는 wire 필드이나 UI 노출 금지, content 유무만으로 렌더 결정). 테스트 커버리지에 E5(63b), I9 미커버(FP-37) 추가.
- 2026-04-11: FP-17/FP-18/FP-19/FP-20/FP-21/FP-24 해소 반영 — I13 보강(disconnected.code별 배너 문구 4종 계약화). I14 신규(진입 시 stdout 출력 순서: 연결 중 메시지 + 세션 초기화 메시지). I15 신규(비밀번호 에코 금지). 테스트 커버리지에 I13/I14/I15 미커버 추가.
- 2026-04-12: FP-04/FP-09/FP-25/FP-26 해소 반영 — I16 신규(cancel 피드백 메시지는 TUI local-only ephemeral). 키 힌트 라인 노출 조건(idle 상태 전용)은 TUI 내부 렌더링 정책이므로 이 스펙에 포함하지 않음. 테스트 커버리지에 I16 미커버 추가.
