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
  - `POST /api/sessions` — 세션 생성. 요청 body: `{ id?, type?, workingDir? }` (`workingDir`은 서버가 무시). 응답 body(201): `{ id, type, workingDir }` (effective workingDir — 항상 `Config.userDataPath(userId)` 반환)
  - `DELETE /api/sessions/:id` — 세션 삭제
  - `GET  /api/sessions/:id/tools` — 세션 도구 목록
  - `GET  /api/sessions/:id/agents` — 세션 에이전트 목록
  - `GET  /api/sessions/:id/config` — 세션 설정 조회
  - `POST /api/sessions/:id/chat` — 사용자 입력 전송
  - `POST /api/sessions/:id/approve` — 승인/거절 응답
  - `POST /api/sessions/:id/cancel` — 처리 취소
  각 엔드포인트의 의미는 `session.md`, `auth.md`에 위임한다.
- I5. **401 자동 refresh + 인증 실패 수렴**: HTTP 클라이언트(`createAuthClient`)는 401 응답 시 `authState`가 있고 refresh 토큰이 유효하면 `POST /api/auth/refresh` 1회 시도 후 원래 요청을 재시도한다. refresh 실패 시 `opts.onAuthFailed()` 콜백을 호출한 뒤 `{ kind: 'AUTH_FAILED' }` sentinel error를 throw한다. `handleInput`은 `AUTH_FAILED` 에러를 swallow한다(disconnected 배너가 이미 노출되므로 재출력 없음). 동시 다발 401 요청은 단일 `refreshPromise`로 직렬화(`createTokenRefresher`의 Promise 단일화). `onAuthFailed` 콜백은 `runRemote` 내에서 late-binding으로 교체된다:
  - 부트스트랩 단계(세션 생성 전): `console.error` + `process.exit(1)` — fail-fast. 유저는 TUI를 재실행해 로그인 루프로 진입.
  - 세션 생성 후(runtime): `session.markDisconnected(4001)` — WS close 4001과 동일한 disconnected 배너 UX로 수렴. `RemoteSession.markDisconnected(code)`는 `#disconnected = { code, at: Date.now() }`를 설정하고 App을 rerender한다.
  - `opts.httpFn`은 테스트에서 `jsonRequest`를 대체하기 위한 주입 지점(기본값 `jsonRequest`).

**WebSocket 프로토콜**

- I6. **WS 연결 인증**: `createMirrorState` 호출 시 `authState.accessToken`이 있으면 `Authorization: Bearer <token>` 헤더를 포함해 WebSocket upgrade 요청을 보낸다. 서버의 WS 인증 3단계 폴백(헤더 → query param → 쿠키) 중 TUI는 헤더 방식만 사용한다.
- I7. **WS 메시지 시퀀스**: 연결(`open`) 즉시 클라이언트가 `{ type: 'join', session_id: <sessionId> }`를 전송한다. `cwd` 필드는 전송하지 않는다 — workingDir은 서버가 `userId` 기반으로 자동 결정하므로 TUI 입력이 불필요하다 (`agent-identity.md I-WD`). 서버는 순서대로 `{ type: 'init', session_id, state: <snapshot>, stateVersion, workingDir: <effective> }` → `{ type: 'state', session_id, path, value }` (변경 발생 시마다)를 push한다. `init` 응답의 `workingDir`은 세션의 effective workingDir (`Config.userDataPath(userId)`)이며 TUI가 매 join 시 수신한다.
- I8. **MirrorState 구독 경로**: `MirrorState.applySnapshot()`은 `SNAPSHOT_PATHS`에 정의된 경로(turnState, lastTurn, turn, context.memories, context.conversationHistory, _streaming, _retry, _approve, _debug.*, _budgetWarning, _toolResults, _toolTranscript, _pendingInput, todos, events, delegates)만 local cache에 반영한다. 그 외 경로는 수신해도 무시한다.
- I10. **WS close 코드 분기 처리**: `MirrorState.handleClose(code)`는 close 코드에 따라 네 가지 경로로 분기한다.
  - `4002`(`PASSWORD_CHANGE_REQUIRED`) / `4003`(`ORIGIN_NOT_ALLOWED`): 재연결 즉시 중단 + `onUnrecoverable(code)` 콜백 호출.
  - `4001`(`AUTH_FAILED`): `onAuthFailed()` 콜백으로 토큰 갱신 1회 시도. 성공 시 즉시 재연결, 실패 시 `onUnrecoverable(code)` 호출 후 중단.
  - `4004`(`WORKING_DIR_INVALID`): (제거됨) W1 리팩토링으로 이 close 코드 경로가 삭제되었다. `WS_CLOSE` 상수에도 존재하지 않는다.
  - 그 외: 기존 지수 백오프(최소 500ms, 최대 15,000ms) 재연결.
  콜백은 `RemoteSession` 생성자가 `tryRefresh`를 받아 `MirrorState`에 주입한다.
- I13. **onUnrecoverable 발동 시 UI 상태**: `RemoteSession.#createMirrorState`의 `onUnrecoverable(code)` 콜백이 호출되면 `#disconnected = { code, at: Date.now() }`를 설정하고 App을 rerender한다. App은 `disconnected` prop이 non-null이면 빨간 double-border 배너를 렌더링하고 `InputBar.disabled`를 true로 설정한다. 배너의 사유 문구(`disconnectedReason`)는 close code에 따라 분기된다:
  - `4001` → "세션이 만료되었습니다"
  - `4002` → "비밀번호 변경이 필요합니다"
  - `4003` → "접근이 거부되었습니다"
  - 그 외 → "서버 연결이 끊겼습니다"
  (`4004`는 W1 리팩토링으로 제거되어 도달하지 않는다.)
  배너 본문: `"⚠ {disconnectedReason} (close {code})."` + `"TUI 를 재시작하세요 (Ctrl+C)."`. `InputBar`에는 `hint` prop으로 i18n 키 `input_hint.disconnected`("연결 끊김 · Ctrl+C로 재시작") 값이 전달된다. 배너 표시는 "복구 불가"(4001 refresh 실패, 4002, 4003, 4004) 경로에만 한정된다 — 백오프 재연결 경로에서는 발동하지 않는다.
- I11. **WS 재연결 시 최신 토큰 사용**: `MirrorState.connect()`는 매번 `getHeaders()` 콜백을 호출하여 최신 Authorization 헤더를 사용한다. `onAuthFailed` 성공 후 갱신된 access token이 다음 재연결에 자동 반영된다.

**TUI 진입 stdout 출력**

- I14. **진입 시 stdout 출력 순서**: `main()`은 아래 두 메시지를 stdout에 출력한다 (I1 부팅 순서와 연동).
  1. `resolveServerUrl` 직후: `"연결 중: {url} [{label}]"`. `label`은 URL 결정 근거로 `'arg'` → `"--server"`, `'env'` → `"PRESENCE_SERVER"`, `'default'` → `"기본값"`.
  2. `loginFlow` 완료 후 `runRemote` 호출 직전: `"세션을 초기화하는 중..."`.
  두 메시지는 stderr가 아닌 stdout. 서버 도달 불가(I1 exit 경로) 또는 로그인 실패(exit) 시에는 두 번째 메시지가 출력되지 않는다.
- I15. **비밀번호 입력 에코 금지**: `promptPassword`는 사용자가 입력하는 문자를 터미널에 에코하지 않는다. 길이를 추론할 수 있는 어떤 문자(`*` 포함)도 출력되지 않는다. prompt 문자열 자체는 출력된다.

**세션 전환**

- I9. **switchSession 순서**: `MirrorState.disconnect()` → `currentSessionId` 갱신 → `createMirrorState(newId)` (새 WS 연결) → `GET /api/sessions/:newId/tools` → `#pendingInitialMessages`에 `{ role: 'system', content: t('sessions_cmd.switched', { id }), transient: true }` 주입 → App 재렌더. App 재렌더 시 `#buildAppProps()`가 `#consumePendingInitialMessages()`를 한 번 소비하여 `initialMessages` prop으로 전달한다. 소비 후 `#pendingInitialMessages`는 초기화된다. tools 조회 실패 시 이전 tools를 유지한다. 주입되는 메시지는 `transient: true` 필드를 포함하며 TUI는 이를 과도 메시지(transient)로 처리한다. TUI 초기 마운트 시 (`initialMessages = []`) 배너는 표시되지 않는다 — 세션 전환이 발생한 경우에만 주입된다.

**취소 피드백**

- I16. **cancel 피드백 기록 경로**: Esc 키가 working 상태에서 `POST /api/sessions/:id/cancel`을 유발하면 서버 turn-controller는 abort 신호만 전송한다. abort가 확정되어 interpreter가 예외를 throw하면 executor.recover가 `INV-ABT-1`의 OR 조건으로 abort를 판별하여, abort 확정 경로에서만 `turnLifecycle.recordAbortSync(state, turn)`을 호출한다. 이 호출은 `conversationHistory`에 cancelled turn entry (`{ cancelled: true, failed: true, errorKind: 'aborted' }`)와 SYSTEM cancel entry (`{ type: 'system', tag: 'cancel', content: '사용자가 응답을 취소했습니다.' }`)를 순서대로 append한다. 이미 완료된 턴에 대한 후행 cancel은 `turnLifecycle.markLastTurnCancelledSync`가 가장 최근 turn entry에 `cancelled: true` 플래그만 부여 (SYSTEM entry는 생성하지 않음).
- I12. **세션 전환 후 StatusBar 갱신**: `switchSession` 완료 후 App 재렌더 시 `sessionId` prop이 새 세션 ID로 업데이트된다. StatusBar는 이를 받아 `session: {id}` 세그먼트를 갱신한다. `session` 항목은 `DEFAULT_ITEMS`에 포함되므로 기본 표시된다. 서버 세션 모델에 `name` 필드가 없으므로 표시 식별자는 `sessionId` 단일 경로다.

**히스토리 스키마**

- INV-SYS-1. **conversationHistory entry 타입 구분**: `conversationHistory`의 entry는 `type` 필드로 구분된다. `type: 'turn'` (생략 가능)은 기존 `{ id, input, output, ts, cancelled?, failed?, errorKind?, errorMessage? }` 형식이고, `type: 'system'`은 `{ id, type: 'system', content, tag?, ts }` 형식이다. SYSTEM entry는 prompt assembly (`flattenHistory`) 및 compaction (`compactionPrompt`, `extractForCompaction`)에서 배제된다. 판별식은 `entry.type || 'turn'`으로 하위 호환되며 migration은 불필요.
- INV-SYS-2. **cancel SYSTEM entry 생성 경로**: cancel SYSTEM entry는 abort 확정 경로 (executor.recover)에서만 append된다. turn-controller.handleCancel은 abort 신호 전송과 후행 cancel 플래그만 담당한다.
- INV-SYS-3. **approve/reject SYSTEM entry 생성 경로**: approve / reject SYSTEM entry는 turn-controller.handleApproveResponse 시점에 `turnLifecycle.appendSystemEntrySync`로 기록된다. 동일한 seq/trim 규칙 (history-writer의 makeEntry, appendAndTrim, HISTORY.MAX_CONVERSATION)을 공유.

**FSM 전이 단일 경로**

- INV-FSM-SINGLE-WRITER. **FSM runtime 이 유일한 전이 경로**: `turnState` / `approveState` / `delegateState` 는 FSM runtime (턴 컨트롤러, executor, delegateFSM) 을 통해서만 전이된다. 외부에서 imperative set (직접 state 할당) 하는 것은 계약 위반이다. FSM 외부에서 이 세 필드를 쓰면 상태 일관성이 깨진다.
- INV-FSM-R1. **aggregation 시 explicit reject 우선**: approve aggregation 단계에서 explicit reject 결과가 하나라도 있으면 전체 결과는 reject로 수렴한다. no-match (approve/reject 결정 없음) 는 non-fatal — reject 로 취급하지 않는다.

**workingDir 해결 및 경계**

- INV-WD-CHAIN. **workingDir 단일 결정 규칙**: 모든 세션의 `workingDir`은 `Config.userDataPath(userId)` 고정. `POST /sessions` body의 `workingDir`, `allowedDirs`, TUI `cwd`, `process.cwd()`는 일절 사용되지 않는다. `pendingBackfill` 개념은 제거되었다. 세부 규칙은 `agent-identity.md I-WD`.
- INV-WD-BOUND. **workingDir 경계 = userDataPath 내부**: 툴/shell_exec의 파일 경로 경계는 `workingDir`(`Config.userDataPath(userId)`)이며 `isWithinWorkspace(path, workingDir)` (lexical prefix)로 검사한다. 경계 밖 접근 시 인터프리터가 에러를 throw한다. `allowedDirs` 개념은 제거되었다.
- INV-WD-BACKFILL. (제거됨) `pendingBackfill`/backfill 메커니즘은 W1 리팩토링으로 삭제되었다.
- INV-WD-PROMPT. **프롬프트 workingDir 섹션**: 모든 세션에서 system prompt에 `PROMPT_SECTIONS.WORKING_DIR(workingDir)` 섹션이 포함된다. `workingDir`은 항상 `Config.userDataPath(userId)`이므로 미결정 상태가 없다.

**stateVersion 단조증가**

- INV-VER-MONOTONIC. **stateVersion 은 단조증가 sortable UUID**: `stateVersion` 은 wall-clock + 시퀀스 기반 sortable monotonic UUID 로 생성된다. 서버 재시작 후에도 `restoreStateVersion` 이 이전 값을 복원하여 단조증가를 보장한다. 클라이언트는 수신한 stateVersion 이 이전 값보다 작으면 경고한다.

**클라이언트 stale 감지 및 reject 응답 reconcile**

- INV-RFS-STALE. **클라이언트 stale 감지 시 requestRefresh**: 클라이언트가 WS event 의 `stateVersion` 과 로컬 `lastStateVersion` 을 비교하여 stale 을 감지하면 `requestRefresh` 를 호출해 서버에 최신 snapshot 을 요청한다.
- INV-RJT-SNAPSHOT. **chat 500 에러 응답은 snapshot 동반**: `POST /api/sessions/:sessionId/chat` 엔드포인트에서 턴 실행 중 예외가 발생하면 서버는 `{ type: 'error', content, stateVersion, snapshot }` 형식으로 500 응답을 반환한다. 클라이언트(`#reconcileIfStale`)는 응답에 `snapshot` 필드가 있으면 즉시 `mirror.applySnapshot`을 호출하여 로컬 상태를 최신 서버 상태로 교체한다. approve / cancel 엔드포인트는 `stateVersion` 만 동봉하며 snapshot 을 포함하지 않는다.

**abort 판별**

- INV-ABT-1. **executor.recover abort 판별 조건**: executor.recover의 abort 판별은 `err.name === 'AbortError' || (actors.isAborted && actors.isAborted())` (OR 조건)이다. LLM 인터프리터가 AbortError를 항상 throw하지 않을 수 있으므로 `turnController.isAborted()` getter로 보강한다. abort 확정 시 `lastTurn.tag === 'failure'` + `lastTurn.error.kind === 'aborted'`로 표시된다 (TurnOutcome 확장 없이 errorKind로 구분).

**/clear 초기화 범위**

- INV-CLR-1. **clearDebugState 초기화 범위**: `clearDebugState()`는 `context.conversationHistory`, `context.memories`, `_pendingInput`, `_toolTranscript`, `_budgetWarning`, 디버그 state를 모두 초기화하며 `_compactionEpoch`를 증분한다. TUI는 optimistic clear (`optimisticClearTs = Date.now()`)로 즉시 화면을 비우고, 서버 reset 후 history가 빈 배열로 전이되는 순간 `optimisticClearTs`를 0으로 reset.

**후행 cancel 타겟**

- INV-CNC-1. **markLastTurnCancelledSync 타겟 탐색**: `markLastTurnCancelledSync`는 history 배열을 뒤에서부터 순회하여 가장 최근 turn entry에 `cancelled: true` 플래그를 부여한다. SYSTEM entry는 건너뛴다 (approve/cancel SYSTEM entry가 turn entry 뒤에 붙을 수 있음).

**pendingInput 계약**

- INV-PND-1. **_pendingInput 수명 계약**: `_pendingInput`은 executor.beginLifecycle에서 user input으로 set되고, turn-lifecycle.finish / executor.recover / clearDebugState에서 null로 정리된다 (4 경로 cleanup). TUI는 `_pendingInput`이 non-null인 동안 user 메시지로 렌더하고, 서버 history에 turn entry가 기록되면 pendingInput null로 전환되며 history entry로 자연스럽게 대체된다.

**toolTranscript 계약**

- INV-TTR-1. **_toolTranscript 누적 계약**: `_toolTranscript`는 tool 실행 결과가 append-only로 누적되는 경로다. 각 entry는 `{ tool, args, result, ts }` 형식이며 `HISTORY.MAX_TOOL_TRANSCRIPT` (현재 500) 상한. `/clear`에서만 초기화되며 턴 경계에서 reset되지 않는다 (`_toolResults`와 달리 세션 전체 누적).

## 경계 조건 (Edge Cases)

- E5. **`_streaming.length` — wire 전송되나 UI 노출 없음**: 서버→TUI로 전송되는 `_streaming` 객체는 `{ status, content, length }` 세 필드를 포함한다. `length`는 스트리밍 누적 바이트 수(내부 지표)이며 TUI UI에 직접 노출하지 않는다. App은 `content` 유무만으로 `thinking...` vs 마크다운 렌더를 결정한다. `length`를 UI 분기 조건으로 사용하거나 화면에 출력하는 것은 계약 위반이다.
- E1. **WS close 코드 분기 처리 (해소됨)**: I10으로 불변식 승격. `MirrorState.handleClose(code)`가 4001/4002/4003을 구분하여 처리한다.
- E2. **WS 재연결 시 토큰 갱신 없음 (해소됨)**: I11으로 불변식 승격. `getHeaders()` 콜백으로 매 재연결 시 최신 토큰 사용, `onAuthFailed` 성공 후 갱신 토큰 자동 반영.
- E3. **`/api/auth/status` 멀티유저 한계**: `checkServer`가 호출하는 `/api/instance`는 `authRequired` 여부만 반환한다. `auth.md E10` 참조 — `/api/auth/status`는 첫 번째 등록 유저만 노출하므로, 멀티유저 환경에서 TUI가 현재 로그인한 유저를 서버에서 역조회하는 경로는 없다.
- E4. **authRequired=false 분기 미도달 (Known Gap)**: `main.js`의 `serverStatus.authRequired ? loginFlow() : { authState: null, username: null }` 분기에서 `false` 경로는 `auth.md I2`에 의해 `authEnabled`가 `true`로 하드코딩되어 있으므로 운영 환경에서 도달하지 않는다. 이 분기를 활성화하는 설정 경로가 없으므로 사실상 dead code다.

## 테스트 커버리지

- INV-WD-CHAIN → `packages/server/test/server.test.js` S20b (body의 workingDir 무시, 응답 effective workingDir = userDataPath 확인), `packages/infra/test/session.test.js` SD6 (opts.workingDir 무시 + workingDir = userDataPath 고정 + pendingBackfill 필드 없음 확인)
- INV-WD-BOUND → (직접 테스트 없음) ⚠️ isWithinWorkspace 경계 밖 접근 시 throw 검증 단위 테스트 없음
- INV-WD-BACKFILL → (제거됨) W1 리팩토링으로 backfill 메커니즘 자체가 삭제됨. 관련 테스트(SD7~SD10, S20c, S20d) 도 존재하지 않음
- INV-WD-PROMPT → (직접 테스트 없음) ⚠️ workingDir 주입 시 WORKING_DIR 섹션 포함 여부를 검증하는 단위 테스트 없음
- I1, I3 → `packages/server/test/server.test.js` (부팅 플로우, mustChangePassword WS 4002)
- I5 → `packages/tui/test/remote.test.js` (401/refresh 성공/refresh 실패/onAuthFailed 호출/AUTH_FAILED throw/부트스트랩 vs runtime onAuthFailed 분기)
- I7 → `packages/server/test/server.test.js` (join/init/state 시퀀스)
- I9, I12 → `packages/tui/test/scenarios/session-switch.scenario.js` (FP-14, 전환 후 StatusBar session 세그먼트 표시 검증)
- I9 (switchSession 시스템 메시지 주입) → (직접 테스트 없음) ⚠️ pendingInitialMessages 소비 및 ChatArea 노출 시나리오 테스트 없음 (FP-37)
- E5 → `packages/tui/test/app.test.js` 63b (content 없을 때 "receiving" 미노출, "thinking" 표시 검증)
- I10, I11 → (직접 테스트 없음) ⚠️ MirrorState close 코드 분기 및 getHeaders 콜백 단위 테스트 없음
- I13 → (직접 테스트 없음) ⚠️ onUnrecoverable 발동 시 code별 배너 문구 + InputBar disabled 시나리오 테스트 없음 (FP-22, FP-24)
- I14 → (직접 테스트 없음) ⚠️ 진입 시 stdout 출력 순서(resolveServerUrl 출력, 세션 초기화 출력) 단위 테스트 없음 (FP-17, FP-21)
- I15 → (직접 테스트 없음) ⚠️ promptPassword 에코 억제 단위 테스트 없음 (FP-18)
- I16 → `packages/core/test/core/agent.test.js` "Executor.recover abort 경로 분기" (cancelled turn entry + SYSTEM cancel entry 순서 검증), `test/e2e/tui-e2e.test.js` TE24 (cancel 순서 보존)
- INV-SYS-1 → `packages/core/test/core/prompt.test.js` 25 (flattenHistory SYSTEM 배제), 26 (type 생략 하위 호환), 27 (fitHistory SYSTEM 비용 0), `packages/core/test/core/compaction.test.js` B4 (compactionPrompt SYSTEM 배제), E10 (extractForCompaction SYSTEM 임계치 카운트 배제), E11 (turn count 초과 시 SYSTEM 포함 추출)
- INV-SYS-2 → `packages/infra/test/turn-controller.test.js` TC1 (handleCancel 은 abort 신호만, SYSTEM entry 직접 쓰지 않음), `packages/core/test/core/agent.test.js` "Executor.recover abort 경로 분기" (recordAbortSync 호출)
- INV-SYS-3 → `packages/infra/test/turn-controller.test.js` TC6 (approve SYSTEM entry), TC7 (reject SYSTEM entry), `packages/core/test/core/turn-lifecycle.test.js` S1 (appendSystemEntrySync)
- INV-ABT-1 → `packages/core/test/core/agent.test.js` "Executor.recover abort 경로 분기" (isAborted=true 경로, cancelled turn + SYSTEM entry 기록), "Executor.recover 일반 error 경로는 SYSTEM entry 없음" (isAborted=false 경로), `packages/infra/test/turn-controller.test.js` TC8 (isAborted() getter), TC1b (turnState=idle이면 abort no-op 회피)
- INV-CLR-1 → `packages/core/test/core/apply-final-state.test.js` F14 (history/pendingInput/toolTranscript/budgetWarning 모두 초기화), F15 (빈 state 안전), F16 (MANAGED_PATHS에 PENDING_INPUT 포함)
- INV-CNC-1 → `packages/core/test/core/history-writer.test.js` C4 (SYSTEM entry 건너뜀), C5 (이미 cancelled), C6 (all SYSTEM entries), C7 (여러 SYSTEM skip), `packages/infra/test/turn-controller.test.js` TC5 (turn-controller 경유), `packages/core/test/core/turn-lifecycle.test.js` M1 (뒤에서부터 첫 turn 탐색), M2 (이미 cancelled no-op), M3 (turn 없음 no-op)
- INV-PND-1 → `packages/core/test/core/agent.test.js` "Executor.beginLifecycle → _pendingInput set" ({input, ts} 구조 검증), "Executor.recover: _pendingInput cleared", `packages/core/test/core/apply-final-state.test.js` F14 (clearDebugState 초기화), `test/e2e/tui-e2e.test.js` TE25 (pendingInput 즉시 표시 + dedup)
- INV-TTR-1 → `packages/core/test/interpreter/prod.test.js` 18 (ExecuteTool _toolTranscript 누적), 19 (Parallel 브랜치 격리), `packages/core/test/core/apply-final-state.test.js` F14 (clearDebugState 초기화), `packages/tui/test/interactive.test.js` "toolTranscript: preserved across turns"
- INV-FSM-SINGLE-WRITER → `test/regression/fsm-single-writer.test.js` (정적 검사: `packages/core/src`, `packages/infra/src`, `packages/server/src`, `packages/tui/src` 전체 스캔, bridge 3파일 외 `STATE_PATH.TURN_STATE|APPROVE|DELEGATES` 직접 set 발견 시 실패), `packages/infra/test/turn-controller.test.js` TC-THROW (approveRuntime 미주입 시 onApprove/handleApproveResponse/resetApprove throw 검증)
- INV-FSM-R1 → `packages/core/test/core/fsm-product.test.js` A3, X1, X2 (explicit reject 우선 aggregation 완전 검증)
- INV-VER-MONOTONIC → `packages/core/test/core/fsm-runtime.test.js` SV7–SV13. SV11/SV12 는 재시작 시나리오(`restoreStateVersion` 후 시스템 시각이 복원값 ts 보다 이전이어도 새 version > 복원값) 직접 검증
- INV-RFS-STALE → `packages/infra/test/mirror-state.test.js` SV-MS1 (init stateVersion 기록), SV-MS2 (stale 패치 skip), SV-MS3 (다른 session_id skip), SV-MS5 (`requestRefresh` 동작 검증)
- INV-RJT-SNAPSHOT → `packages/server/test/server.test.js` S21 (Mock LLM handler throw → 500 응답 유도, body shape `{ type: 'error', content, stateVersion, snapshot }` assertion 고정, `snapshot.turnState|turn` 구조 및 `stateVersion` 존재 확인)

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
- 2026-04-12: KG-01 해소 — I5를 "재로그인 유도 미구현 Known Gap"에서 "AUTH_FAILED 수렴 경로" 불변식으로 갱신. 부트스트랩 fail-fast vs runtime markDisconnected(4001) late-binding 계약 명시. RemoteSession.markDisconnected 추가. 테스트 커버리지 I5를 packages/tui/test/remote.test.js로 교체.
- 2026-04-18: FP-61 / KG-14 반영 — 메시지 아키텍처 재설계. 서버 conversationHistory를 TUI 메시지의 단일 진실의 원천으로 승격. history-writer pure helpers와 TurnLifecycle 재구성으로 write 규칙 단일화. I8 갱신 (SNAPSHOT_PATHS에 `_pendingInput`, `_toolTranscript` 추가). I9 갱신 (pendingInitialMessages transient 처리, 초기 마운트 배너 미표시 명시). I16 재정의 (cancel SYSTEM entry로 승격 — TUI local-only ephemeral 에서 서버 conversationHistory 기록으로 변경). INV-SYS-1/2/3, INV-ABT-1, INV-CLR-1, INV-CNC-1, INV-PND-1, INV-TTR-1 신규.
- 2026-04-18: FP-61/KG-14 커버리지 매트릭스 갱신 — INV-SYS-1/2/3, INV-ABT-1, INV-CLR-1, INV-CNC-1, INV-PND-1, INV-TTR-1, I16 의 "(직접 테스트 없음) ⚠️" 를 실제 테스트 경로로 교체.
- 2026-04-20: Phase G 반영 — INV-FSM-SINGLE-WRITER (FSM 단일 전이 경로), INV-FSM-R1 (explicit reject 우선 aggregation), INV-VER-MONOTONIC (stateVersion 단조증가), INV-RFS-STALE (stale 감지 시 requestRefresh), INV-RJT-SNAPSHOT (reject 응답 snapshot reconcile) 신규 추가. 5개 모두 테스트 미커버 ⚠️.
- 2026-04-20: Phase G 커버리지 갱신 — INV-RJT-SNAPSHOT 문구 교정 (적용 엔드포인트를 approve → chat 500 에러 응답으로, payload shape 명시, approve/cancel 은 snapshot 미포함 명시). INV-FSM-R1/INV-VER-MONOTONIC/INV-RFS-STALE 커버리지를 실제 테스트 경로로 교체. INV-FSM-SINGLE-WRITER 는 간접 커버 브리지 테스트 명시 후 ⚠️ 유지. INV-RJT-SNAPSHOT 은 간접 커버 후 단위 테스트 추가 권장 ⚠️ 유지.
- 2026-04-20: INV-FSM-SINGLE-WRITER 정적 검사 + turn-controller legacy 제거, INV-RJT-SNAPSHOT 단위 assertion 추가. 5 항목 모두 직접 테스트 커버.
- 2026-04-20: Phase 20 반영 — INV-WD-CHAIN/BOUND/BACKFILL/PROMPT 신규 추가. I4(POST /sessions 요청/응답 shape에 workingDir 명시), I7(WS join cwd 필드 + init workingDir 응답 명시), I10(WS 4004 WORKING_DIR_INVALID 분기 추가), I13(4004 배너 문구 추가). 4개 INV 모두 테스트 커버 추가 (INV-WD-PROMPT만 ⚠️ 미커버).
- 2026-04-25: codex 검증 후 W1 잔재 테스트 매핑 정리 — INV-WD-CHAIN 커버리지에서 SD7/SD8/SD9(pendingBackfill, allowedDirs, 경계 밖 throw), S20c(HTTP 400), S20d(WS join cwd backfill) 제거. W1(cb6c59a)로 해당 테스트와 필드가 삭제됨. INV-WD-BOUND는 직접 테스트 없음 ⚠️ 로 정정. INV-WD-BACKFILL은 메커니즘 자체 삭제로 테스트 불필요 명시.
