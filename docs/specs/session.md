# 세션 생명주기 정책

## 목적

presence의 세션 유형, 생성/종료 순서, 소유권 규칙, 유저 격리를 정의한다. 세션은 반드시 정해진 알고리즘 순서로 초기화되고, 소유자 외에 접근할 수 없다.

## 세션 유형

SESSION_TYPE 상수(`packages/infra/src/infra/constants.js`)를 기준으로 3가지 유형이 존재한다.

| SESSION_TYPE 값 | 설명 | persistence | 구현 클래스 |
|----------------|------|-------------|------------|
| `user` | 클라이언트 연결 기반 대화 세션 | 있음 (디스크) | `UserSession` |
| `scheduled` | 스케줄러가 잡 실행 시 생성, 완료 시 destroy | 없음 | `EphemeralSession` |
| `agent` | 다른 에이전트로의 위임 처리 | 없음 | `EphemeralSession` |

> `EphemeralSession`은 `scheduled`와 `agent` 두 유형 모두에 사용되는 공통 구현 클래스다. `Session.create()` 팩토리가 `type` 파라미터 기준으로 `UserSession` 또는 `EphemeralSession`을 선택한다.

## 불변식 (Invariants)

- I1. **생성 순서 불변**: `Session` 생성자의 `init*` 단계는 항상 `workingDir 결정(생성자 직접, userId 기반 자동) → initState → initTurnControl → initPersistence → restoreState → initToolRegistry → initInterpreter → initActors → initAgent → initScheduler → initTools → initMonitor` 순서로 실행된다. `workingDir`은 생성자에서 `Config.userDataPath(userId)`로 확정되며, 이후 변경되지 않는다. 세부 규칙은 `agent-identity.md I-WD` 참조.
- I2. **종료 순서 불변**: `shutdown()` 시 `shutdownScheduler → shutdownActors → clearTimers → flushPersistence` 순서. 데이터 없이 종료 시 `cleanup()` = `shutdown()` + `clearPersistence()`. `shutdownActors`(`SessionActors.shutdown()`)는 `delegateActor.stop()`만 명시적으로 호출한다. `memoryActor`, `compactionActor`, `turnActor`, `eventActor`, `budgetActor`는 명시적 stop 없이 fire-and-forget으로 진행 중인 작업이 프로세스 종료와 함께 자연 폐기된다. 이는 actor들의 상태가 모두 메모리/세션 영속 레이어에 동기화된 후에만 shutdown이 호출된다는 전제에 의존한다. `UserContext.shutdown()` 순서: `clearInterval(a2aExpireInterval) → await a2aExpireInFlight → sessions.shutdown() → jobStore.close() → userDataStore.close() → a2aQueueStore.close() → mcpConnections.close()`.
- I3. **세션 소유권**: `entry.owner`가 설정된 세션은 다른 유저가 접근할 수 없다. REST(`session-api.js`)와 WS(`ws-handler.js`) 양쪽에서 동일 규칙 적용. REST 기준: `GET state`, `POST chat/approve/cancel`, `DELETE` 모두 `req.user?.username` vs `entry.owner` 비교로 소유자 검증. `DELETE /sessions/:sessionId`는 `attachSessionMiddleware`를 거치지 않고 `mountSessionsCrud` 내부에서 직접 소유권 체크 (`session-api.js:204`).
- I4. **세션 ID 멱등성**: 같은 `sessionId`로 `sessions.create()` 재호출 시 기존 entry를 반환한다. 중복 생성 없음.
- I5. **기본 세션 자동 생성**: `{username}-default` 패턴의 sessionId로 첫 요청(REST/WS join) 시에만 세션 자동 생성. persistence 경로: `Config.resolveDir()/users/{username}/agents/{agentName}/sessions/{sessionId}/`. M1 단계에서 `agentName`은 `default` 하드코딩. `PRESENCE_DIR` 환경변수가 presenceDir을 override할 수 있으므로 경로는 `~/.presence/...`가 아닐 수 있다.
- I6. **UserContext 소유**: 세션은 UserContext에 귀속된다. 한 유저의 세션이 다른 유저의 UserContext 인프라(`llm`, `toolRegistry`, `jobStore`, `userDataStore`)를 사용할 수 없다.
- I7. **EphemeralSession은 persistence 없음**: `scheduled`, `agent` 세션은 디스크에 상태를 저장하지 않는다. NOOP_PERSISTENCE_ACTOR를 사용한다.
- I8. **SessionManager는 UserContext 하위**: SessionManager는 UserContext의 인프라를 공유하되, 세션 생명주기(create/get/list/destroy)만 담당한다.
- I9. **세션 destroy = cleanup**: `sessions.destroy(id)` 호출 시 `session.cleanup()` (shutdown + clearPersistence)이 실행된다. 이미 없는 세션 destroy는 no-op.
- I11. **현재 세션 가시성**: TUI는 항상 현재 활성 세션의 `sessionId`를 StatusBar에 표시해야 한다. 세션 전환(switchSession) 완료 후 StatusBar는 새 sessionId를 반영해야 한다. 서버 세션 모델에는 `name` 필드가 없으므로 식별자는 `sessionId` 단일 경로다.
- I14. **세션 workingDir은 생성 시 Config.userDataPath(userId)로 고정**: 세션의 `workingDir`은 `Config.userDataPath(userId)`로 자동 결정된다. `POST /sessions` body의 `workingDir`, TUI `cwd`, `allowedDirs` 개념은 사용되지 않는다. `process.cwd()`도 사용되지 않는다. 세부 규칙은 `agent-identity.md I-WD` 참조.
- I15. **UserSession은 workingDir을 persistence에 저장하지 않음**: `UserSession.flushPersistence()`는 `workingDir`을 state.json에 저장하지 않는다. 복원(restoreState) 시에도 `workingDir`을 복원하지 않으며, 항상 생성 시 `userId` 기반으로 재계산된다. `pendingBackfill` 필드는 제거되었다.
- I12. **알 수 없는 슬래시 커맨드는 에이전트로 전달되지 않는다**: `/`로 시작하는 모든 입력은 `dispatchSlashCommand`가 흡수한다. `commandMap`에 없는 커맨드는 `slash_cmd.unknown` 안내 메시지로 차단되고 `return true`로 처리 완료 마킹된다. 에이전트 턴이 유발되지 않는다. `/`로 시작하지 않는 입력은 이 불변식의 적용 대상이 아니다.
- I10. **세션 destroy는 메모리를 건드리지 않음**: `session.cleanup()`은 **세션 범위 영속화**(state.json 등)만 제거한다. `Memory`는 `agentId` 단위로 격리되어 있고 한 agent가 여러 세션을 가질 수 있으므로, 한 세션 삭제가 해당 agent의 `Memory`를 지우면 **다른 세션의 맥락이 함께 파괴**된다. 메모리 삭제는 (a) 유저가 `/memory clear` 슬래시 커맨드로 명시 삭제하거나, (b) 관리자 CLI의 `removeUserCompletely`로 유저 자체를 삭제할 때만 일어난다.
- I16. **A2A session 라우팅 — 두 API**: `SessionManager` 는 A2A 경로를 위해 서로 목적이 다른 두 개의 조회 API 를 제공한다.
  - `findAgentSession(agentId)`: request **수신** 라우팅 (S1). `type === SESSION_TYPE.AGENT` + `session.agentId` 일치 entry 만 선택. dual-homed 상황에서도 AGENT session 만 선택 — A2A request 가 UserSession 대화 흐름을 교란하지 않는다.
  - `findSenderSession(agentId)`: response **송신자** 조회 (S2). USER + AGENT 양쪽 검색, AGENT 우선. `Op.SendA2aMessage` 는 UserSession turn 에서도 호출 가능하므로 response 가 대화창으로 돌아가야 유저가 확인할 수 있다. AGENT 없으면 USER fallback.
  - 두 API 공통 tagged union 반환: `{ kind: 'ok', entry }` (1개 매치), `{ kind: 'not-registered', entry: null }` (0개 매치), `{ kind: 'ambiguous', entry: null }` (2개 이상 — 방어).
  - **turnLifecycle 전파 불변식**: `SessionActors` 가 `EventActor` 를 생성할 때 `turnLifecycle` 을 주입한다. `a2a_response` drain 시 `EventActor` 는 `turnLifecycle.appendSystemEntrySync` 를 사용해 SYSTEM entry 를 추가한다. `turnLifecycle` 미주입 fallback: warn 로그 + drain 계속 (response 표시 불가, 이벤트 유실 없음).
  - **A2A event type 범용성 불변식**: EVENT_TYPE 은 도메인 불특정이다. `EVENT_TYPE.A2A_REQUEST = 'a2a_request'` / `EVENT_TYPE.A2A_RESPONSE = 'a2a_response'` 가 프리미티브이며 `todo_request` / `question_request` 같은 category 특정 이름을 EVENT_TYPE 에 도입하지 않는다. category 분류는 event `payload.category` 필드로 전달하고 EVENT_TYPE 은 전송 채널 역할만 담당한다. (`packages/core/src/core/policies.js` `EVENT_TYPE` 상수 — `TODO_REVIEW` 는 UserDataStore 도메인 이벤트로 별개 유지).
  - **재시작 회복 (S4)**:
    - `UserContext.recoverA2aQueue({ sessionManager, recoverOnStart = true })`: feature flag `config.a2a.recoverOnStart` (default true). false 면 skip.
    - **호출 경로 두 곳 모두 보장**: (a) 메인 부트 (`server/index.js`) `registerAgentSessions(...)` 직후, (b) 인증 모드 lazy 부트 (`user-context-manager.js` `getOrCreate`) `registerAgentSessions(...)` 직후.
    - **row 별 처리 정책**: `processing` → `markFailed('server-restart')` + `dispatchResponse`; `pending` + receiver 등록 → receiver event queue 재진입 (실패 시 `markFailed('server-restart-enqueue-failed')`); `pending` + receiver 부재 → `markFailed('server-restart-target-missing')`.
    - **recovery 완료 불변식**: 정상 종료 후 silent forever-pending row 없음 — 모든 row 는 pending+receiver queue 진입 또는 failed 둘 중 하나.
    - bounded batch: 한 번 startup 에 최대 `A2A.RECOVER_BATCH_MAX = 1000` row 처리 (`listByStatus` 호출). recovery 멱등 (`markFailed` boolean 반환으로 이미 처리된 row skip).
    - **i18n humanize**: `formatResponseMessage` 가 `a2a.error.*` 매핑으로 사용자 대화창에 한국어/영어 메시지 출력. `event.error` raw 코드 직접 노출 차단. interpreter 결과는 raw 코드 유지 (표시 계층만 변환).
  - **UserContextManager single-flight 불변식**: `UserContextManager.getOrCreate` 는 `#pending` Promise 캐싱으로 동시 첫 접근 시 `UserContext.create` + recovery 가 두 번 실행되지 않게 차단.
- I13. **관리자 CLI 유저 삭제는 3단계 원자 절차**: `removeUserCompletely({ store, memory, username, userDir, agentIds })`는 아래 순서로 실행된다.
  1. `agentIds` 배열의 각 `agentId`에 대해 `memory.clearAll(agentId)` 순회 호출 — mem0에서 agent별 데이터 전량 삭제. `memory === null`이거나 `agentIds`가 빈 배열이면 skip. `agentIds`는 호출처(`cmdRemove`)가 현재 config의 core agents (`default`, `summarizer`) + `config.agents`로부터 구성해 전달.
  2. `userDir` 존재 시 `rmSync(recursive, force)` — 사용자 데이터 디렉토리 재귀 삭제.
  3. `store.removeUser(username)` — users.json에서 레코드 제거.
  단계 1의 `memory.clearAll` throw는 best effort로 처리되어 개별 agent 실패가 나머지 agent 정리와 단계 2, 3의 진행을 막지 않는다. 존재하지 않는 유저에 대한 호출은 `User not found` 에러를 throw한다.
  **orphan 정책**: `agentIds`는 현재 config에 등록된 agent 이름 집합 기준으로만 구성된다. 과거에 존재했다가 제거/rename된 agent의 mem0 엔트리는 삭제되지 않는다. 같은 agent name을 재생성하면 동일 qualified key로 재조회 가능하다. 완전 청소는 운영자가 `config.memory.path`를 수동으로 비우는 방법으로만 가능 (`memory.md E4a` 참조).

## 경계 조건 (Edge Cases)

- E1. 세션이 없는 sessionId로 REST 접근 → 404 반환. `{username}-default` 패턴이면 자동 생성 후 진행.
- E2. 유저 A가 유저 B 소유 세션에 접근 → `entry.owner !== username` 조건으로 403 반환.
- E2a. 다른 유저 토큰으로 `DELETE /sessions/:sessionId` 시도 → 동일한 소유권 체크로 403 반환. `mountSessionsCrud` 내부 직접 검증.
- E3. `restoreState` 중 JSON 파싱 오류 → `logger.warn` 후 fresh state로 시작. 이전 상태 유실은 허용.
- E4. 진행 중인 턴과 동시에 새 handleInput 요청 → TurnController는 직렬화 큐 없이 병렬 실행된다. 각 호출이 독립적인 AbortController를 생성하므로, `handleCancel()`은 가장 최근에 설정된 `turnAbort`만 abort한다. 동시 호출 자체를 막는 메커니즘은 없다.
- E5. `scheduled` 세션이 잡 완료 후 destroy되지 않을 경우 → 메모리 누수. `onScheduledJobDone` 콜백에서 반드시 `sessions.destroy(sessionId)` 호출.
- E6. 레거시 경로 (`users/{username}/sessions/{sessionId}/state.json`) 데이터 존재 시 → 자동 마이그레이션 없음. 새 경로(`users/{username}/agents/{agentName}/sessions/{sessionId}/`)에서 찾지 못하면 빈 상태로 시작. 기존 데이터 버림 결정 (`data-scope-alignment.md §6`).
- E7. `{username}-default` 외 임의 sessionId로 첫 요청 → 자동 생성 없음, 404.
- E14. `POST /sessions`에 `workingDir`을 body에 포함해도 → 서버가 무시, 항상 `Config.userDataPath(userId)` 사용. HTTP 201 성공 (값이 틀려도 실패하지 않음).
- E15. TUI가 `cwd`를 WS join 메시지에 포함해도 → 서버가 무시. workingDir backfill 없음.
- E16. (제거됨) `WS_CLOSE.WORKING_DIR_INVALID(4004)` close 코드는 W1 리팩토링으로 제거되었다. `allowedDirs` 경계 위반 경로 자체가 존재하지 않는다.
- E10. `eventActor.inFlight` 또는 `turnActor` 큐에 처리 중 이벤트가 남아있는 상태에서 shutdown이 호출되면 해당 이벤트는 유실될 수 있다. `flushPersistence`는 state만 동기화하며 actor 큐 비우기를 보장하지 않는다. 현재 코드가 이 전제를 강제하지 않는다. Known Limitation.
- E8. SessionManager에서 없는 id로 `get()` 호출 → `null` 반환.
- E9. EphemeralSession의 `flushPersistence()` 호출 → no-op (NOOP 반환). 데이터 손실 없음(애초에 저장 안 함).
- E11. `POST /sessions`의 `type` 파라미터는 `Object.values(SESSION_TYPE).includes(type)` 검증을 거친다. 검증 실패 시 400 반환. 임의 문자열은 통과하지 못한다 (KG-03 해소).
- E13. **관리자 CLI 유저 삭제 시 Memory orphan (해소됨)**: I13으로 불변식 승격. `removeUserCompletely`가 `memory.clearAll` + 디렉토리 삭제 + `store.removeUser` 3단계를 원자적으로 수행하므로, 유저 삭제 후 orphan 메모리가 남지 않는다.
- E12. `/`로 시작하는 입력이 `commandMap`에 없으면 `dispatchSlashCommand`는 `slash_cmd.unknown` i18n 메시지(`tag: 'error'`)를 ChatArea에 추가하고 `true`를 반환한다 — 에이전트 턴이 발생하지 않는다. `/`로 시작하지 않는 일반 입력은 이 경로를 거치지 않는다 (FP-42 해소, 2026-04-12).

## 테스트 커버리지

- I1, I2 → `packages/infra/test/session.test.js` (생성/종료 순서)
- I3 → `packages/server/test/server.test.js` (소유권 403 검증)
- I4 → `packages/infra/test/session.test.js` (중복 create 멱등성)
- I5 → `packages/server/test/server.test.js` (default 세션 자동 생성)
- I7 → `packages/infra/test/session.test.js` (EphemeralSession NOOP persistence)
- I9 → `packages/infra/test/session.test.js` (destroy → cleanup)
- E2 → `packages/server/test/server.test.js` (403 소유권 검증)
- E3 → `packages/infra/test/session.test.js` (restore 실패 시 fresh start)
- E6 → (마이그레이션 없음 — 기존 데이터 버림 결정, 테스트 불필요)
- E4 → `packages/core/test/core/turn-concurrency.test.js`
- I11 → `packages/tui/test/scenarios/session-switch.scenario.js` (세션 전환 후 StatusBar 표시)
- I14 → `packages/infra/test/session.test.js` SD6 (workingDir = userDataPath, body 무시), `packages/server/test/server.test.js` S20b (body workingDir 무시 + effective workingDir 응답 확인)
- I15 → `packages/infra/test/session.test.js` SD6 (pendingBackfill 필드 없음 assertion)
- E14 → `packages/server/test/server.test.js` S20b (workingDir body 무시, 201 성공)
- E15 → `packages/infra/test/session.test.js` SD6 (pendingBackfill=undefined)
- E16 → `packages/tui/test/app.test.js` 62-3 주석 (경로 폐기 명시)
- I12 → (직접 테스트 없음) ⚠️ unknown 슬래시 커맨드 차단 단위 테스트 없음
- I13 → `packages/infra/test/auth-remove-user.test.js` (정상/memory null/memory 실패 best effort/미존재 유저 throw/디렉토리 부재 5개 시나리오)
- I16 → (미커버) ⚠️ findAgentSession/findSenderSession 단위 테스트 없음. `packages/infra/test/session-manager.test.js` 에 아래 시나리오 필요:
  - findAgentSession: AGENT 1개 매치 / dual-homed(USER+AGENT) AGENT 선택 / not-registered / ambiguous
  - findSenderSession: AGENT 우선 / AGENT 없을 때 USER fallback / not-registered / ambiguous(AGENT 2개) / ambiguous(USER 2개)

## 관련 코드

- `packages/infra/src/infra/sessions/session.js` — Session 알고리즘 골격 (Template Method)
- `packages/infra/src/infra/sessions/ephemeral-session.js` — EphemeralSession (scheduled/agent 공통)
- `packages/infra/src/infra/sessions/user-session.js` — UserSession (persistence, scheduler, job 툴)
- `packages/infra/src/infra/sessions/session-manager.js` — 세션 생명주기 관리
- `packages/infra/src/infra/sessions/index.js` — Session.create 팩토리
- `packages/infra/src/infra/user-context.js` — UserContext (세션 포함)
- `packages/server/src/server/session-api.js` — 소유권 검증, 자동 생성, REST 엔드포인트
- `packages/server/src/server/ws-handler.js` — WS join 시 소유권 검증
- `packages/infra/src/infra/auth/remove-user.js` — removeUserCompletely (유저 완전 삭제 3단계)
- `packages/infra/src/interpreter/send-a2a-message.js` — SendA2aMessage 인터프리터 (validateTarget + enqueueRequest + eventActor.enqueue)

## 변경 이력

- 2026-04-11: I11 추가 — 현재 세션 가시성 (sessionId 단일 경로). 서버 세션 모델에 name 필드가 없으므로 sessionName 개념은 스펙에서 제외.
- 2026-04-10: 초기 작성
- 2026-04-10: I5 경로 표기 수정 — `~/.presence/...` 하드코딩에서 Config.resolveDir() 기반으로 정정
- 2026-04-10: E4 TurnController 동시성 기술 정정 — 직렬화 큐/reject 없음. AbortController 기반 개별 abort만 존재
- 2026-04-10: 세션 유형 표 재작성 — SESSION_TYPE 상수(user/scheduled/agent) 기준 3행으로 정리, EphemeralSession을 구현 클래스 열과 각주로 분리
- 2026-04-10: I2 보강 — shutdownActors가 delegateActor.stop()만 명시 호출하고 나머지 actor는 자연 폐기됨을 명시. 이 전제(영속화 완료 후 shutdown)에 대한 의존 명시.
- 2026-04-10: I3 보강 — DELETE /sessions/:sessionId가 mountSessionsCrud 내에서 직접 소유권 체크함을 명시. E2a 추가 (다른 유저 토큰으로 DELETE 시 403). I2에 UserContext.shutdown() 순서 추가. E10 추가 — eventActor inFlight 중 shutdown Known Limitation.
- 2026-04-10: E11 추가 — POST /sessions type 파라미터 SESSION_TYPE 검증 부재 Known Gap. E12 추가 — 미지원 슬래시 커맨드의 에이전트 위임 정책.
- 2026-04-11: I10 추가 — session destroy는 Memory를 건드리지 않음. E13 추가 — user-store.removeUser가 memory.clearAll 미호출 (orphan memory) Known Gap.
- 2026-04-12: FP-42 해소 반영 — E12를 "에이전트 전달" 기술에서 "unknown 차단" 계약으로 교체. I12 신규 추가 — 알 수 없는 슬래시 커맨드는 에이전트로 전달되지 않는다(불변식 승격). FP-43(help /mcp 추가), FP-44(sessions list name 표시), FP-41(세션 커맨드 에러 한글화)는 TUI 내부 렌더링/i18n 변경으로 스펙 대상 아님.
- 2026-04-12: KG-04 해소 — E13을 Known Gap에서 "해소됨"으로 전환(I13으로 불변식 승격). I10 보강 — "관리자 CLI의 removeUserCompletely로 유저 삭제 시 메모리 삭제"가 명시적 구현으로 존재함을 반영. I13 신규 추가 — removeUserCompletely 3단계(memory.clearAll best effort → userDir 재귀 삭제 → store.removeUser), memory null skip, 미존재 유저 throw 계약. 관련 코드에 remove-user.js 추가. 테스트 커버리지에 I13 추가.
- 2026-04-12: KG-03 해소 — E11을 Known Gap에서 정상 동작으로 전환. POST /sessions의 type 파라미터에 SESSION_TYPE 화이트리스트 검증 추가, 실패 시 400 반환.
- 2026-04-20: Phase 20 반영 — I1 생성 순서에 workingDir 결정 단계 명시 및 restoreState 시 덮어쓰기 계약 추가. I14 신규(세션 workingDir 결정 체인). I15 신규(UserSession workingDir persistence). E14/E15/E16 신규(경계 위반 조건과 서버 응답). 테스트 커버리지 I14/I15/E14/E15/E16 추가.
- 2026-04-23: W1(cb6c59a) workingDir 단일 규칙 반영 — I1 생성 순서 기술 정정(restoreState workingDir 복원 제거). I14 재작성(allowedDirs 체인 → Config.userDataPath 고정). I15 재작성(persistence 저장 → 미저장, pendingBackfill 제거). E14/E15/E16 재작성(allowedDirs 경계 위반 경로 폐기). 테스트 커버리지 갱신. agent-identity.md I-WD 참조 추가.
- 2026-04-24: data-scope-alignment 완료 반영 — I5 persistence 경로에 `agents/{agentName}/` 삽입. I10 Memory 격리 단위 userId → agentId. I13 재작성(memory.clearAll 파라미터를 agentId + agentIds 순회로, orphan 정책 명시). E6 레거시 마이그레이션 → "기존 데이터 버림" 결정으로 재작성. 테스트 커버리지 E6 주석 갱신.
- 2026-04-24: A2A Phase 1 S1 구현 반영 — I16 신규(findAgentSession tagged union API 계약, dual-homed 라우팅 규칙). 관련 코드에 send-todo.js 추가. 테스트 커버리지 I16 미커버 경고 등록.
- 2026-04-24: A2A Phase 1 S2 구현 반영 — I16 확장: findSenderSession 계약(USER+AGENT 양쪽, AGENT 우선, USER fallback), turnLifecycle 전파 불변식(SessionActors→EventActor 주입, appendSystemEntrySync, 미주입 fallback). I2 UserContext.shutdown() 순서 갱신(A2A expire tick clearInterval/await 선행 추가, a2aQueueStore.close 추가). 테스트 커버리지 I16 미커버 시나리오 확장.
- 2026-04-25: A2A 네이밍 범용화 반영 (v8) — I16 재작성: findAgentSession/findSenderSession 설명에서 'SendTodo' 참조 제거 → 'Op.SendA2aMessage'. turnLifecycle 전파에서 'todo_response' → 'a2a_response'. A2A event type 범용성 불변식 추가(EVENT_TYPE.A2A_REQUEST/A2A_RESPONSE 프리미티브, category 특정 이름 도입 금지). 관련 코드에서 send-todo.js → send-a2a-message.js 갱신.
- 2026-04-25: A2A Phase 1 S4 구현 반영 — I16 보강: recoverA2aQueue 메서드 계약(feature flag / 두 부트 경로 / row별 처리 정책 / recovery 완료 불변식 / bounded batch / i18n humanize), UserContextManager single-flight 불변식 추가.
