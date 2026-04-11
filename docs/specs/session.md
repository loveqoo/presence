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

- I1. **생성 순서 불변**: `Session` 생성자의 `init*` 단계는 항상 `initState → initTurnControl → initPersistence → restoreState → initToolRegistry → initInterpreter → initActors → initAgent → initScheduler → initTools → initMonitor` 순서로 실행된다.
- I2. **종료 순서 불변**: `shutdown()` 시 `shutdownScheduler → shutdownActors → clearTimers → flushPersistence` 순서. 데이터 없이 종료 시 `cleanup()` = `shutdown()` + `clearPersistence()`. `shutdownActors`(`SessionActors.shutdown()`)는 `delegateActor.stop()`만 명시적으로 호출한다 (`session-actors.js:88-90`). `memoryActor`, `compactionActor`, `turnActor`, `eventActor`, `budgetActor`는 명시적 stop 없이 fire-and-forget으로 진행 중인 작업이 프로세스 종료와 함께 자연 폐기된다. 이는 actor들의 상태가 모두 메모리/세션 영속 레이어에 동기화된 후에만 shutdown이 호출된다는 전제에 의존한다. `UserContext.shutdown()` 순서: `sessions(각 session.shutdown()) → jobStore.close() → userDataStore.close() → mcpConnections.close()` (`user-context.js:115-122`).
- I3. **세션 소유권**: `entry.owner`가 설정된 세션은 다른 유저가 접근할 수 없다. REST(`session-api.js`)와 WS(`ws-handler.js`) 양쪽에서 동일 규칙 적용. REST 기준: `GET state`, `POST chat/approve/cancel`, `DELETE` 모두 `req.user?.username` vs `entry.owner` 비교로 소유자 검증. `DELETE /sessions/:sessionId`는 `attachSessionMiddleware`를 거치지 않고 `mountSessionsCrud` 내부에서 직접 소유권 체크 (`session-api.js:204`).
- I4. **세션 ID 멱등성**: 같은 `sessionId`로 `sessions.create()` 재호출 시 기존 entry를 반환한다. 중복 생성 없음.
- I5. **기본 세션 자동 생성**: `{username}-default` 패턴의 sessionId로 첫 요청(REST/WS join) 시에만 세션 자동 생성. persistence 경로: `Config.resolveDir()/users/{username}/sessions/{sessionId}/`. `PRESENCE_DIR` 환경변수가 presenceDir을 override할 수 있으므로 경로는 `~/.presence/...`가 아닐 수 있다.
- I6. **UserContext 소유**: 세션은 UserContext에 귀속된다. 한 유저의 세션이 다른 유저의 UserContext 인프라(`llm`, `toolRegistry`, `jobStore`, `userDataStore`)를 사용할 수 없다.
- I7. **EphemeralSession은 persistence 없음**: `scheduled`, `agent` 세션은 디스크에 상태를 저장하지 않는다. NOOP_PERSISTENCE_ACTOR를 사용한다.
- I8. **SessionManager는 UserContext 하위**: SessionManager는 UserContext의 인프라를 공유하되, 세션 생명주기(create/get/list/destroy)만 담당한다.
- I9. **세션 destroy = cleanup**: `sessions.destroy(id)` 호출 시 `session.cleanup()` (shutdown + clearPersistence)이 실행된다. 이미 없는 세션 destroy는 no-op.
- I11. **현재 세션 가시성**: TUI는 항상 현재 활성 세션의 `sessionId`를 StatusBar에 표시해야 한다. 세션 전환(switchSession) 완료 후 StatusBar는 새 sessionId를 반영해야 한다. 서버 세션 모델에는 `name` 필드가 없으므로 식별자는 `sessionId` 단일 경로다.
- I12. **알 수 없는 슬래시 커맨드는 에이전트로 전달되지 않는다**: `/`로 시작하는 모든 입력은 `dispatchSlashCommand`가 흡수한다. `commandMap`에 없는 커맨드는 `slash_cmd.unknown` 안내 메시지로 차단되고 `return true`로 처리 완료 마킹된다. 에이전트 턴이 유발되지 않는다. `/`로 시작하지 않는 입력은 이 불변식의 적용 대상이 아니다.
- I10. **세션 destroy는 메모리를 건드리지 않음**: `session.cleanup()`은 **세션 범위 영속화**(state.json 등)만 제거한다. `Memory` 는 `userId` 단위로 격리되어 있고 한 유저가 여러 세션을 가질 수 있으므로, 한 세션 삭제가 유저의 `Memory` 를 지우면 **다른 세션의 맥락이 함께 파괴**된다. 메모리 삭제는 (a) 유저가 `/memory clear` 슬래시 커맨드로 명시 삭제하거나, (b) 관리자 CLI로 유저 자체를 삭제할 때만 일어나야 한다. 현재 `user-store.removeUser()`는 사용자 레코드만 제거하고 `memory.clearAll(userId)` 를 호출하지 않아 orphan 메모리가 남을 수 있다 — Known Gap (별도 항목 참고).

## 경계 조건 (Edge Cases)

- E1. 세션이 없는 sessionId로 REST 접근 → 404 반환. `{username}-default` 패턴이면 자동 생성 후 진행.
- E2. 유저 A가 유저 B 소유 세션에 접근 → `entry.owner !== username` 조건으로 403 반환.
- E2a. 다른 유저 토큰으로 `DELETE /sessions/:sessionId` 시도 → 동일한 소유권 체크로 403 반환. `mountSessionsCrud` 내부 직접 검증.
- E3. `restoreState` 중 JSON 파싱 오류 → `logger.warn` 후 fresh state로 시작. 이전 상태 유실은 허용.
- E4. 진행 중인 턴과 동시에 새 handleInput 요청 → TurnController는 직렬화 큐 없이 병렬 실행된다. 각 호출이 독립적인 AbortController를 생성하므로, `handleCancel()`은 가장 최근에 설정된 `turnAbort`만 abort한다. 동시 호출 자체를 막는 메커니즘은 없다.
- E5. `scheduled` 세션이 잡 완료 후 destroy되지 않을 경우 → 메모리 누수. `onScheduledJobDone` 콜백에서 반드시 `sessions.destroy(sessionId)` 호출.
- E6. 레거시 상태 파일(`users/{username}/state.json`) 존재 시 → 새 경로(`sessions/{sessionId}/state.json`)로 자동 마이그레이션 (`renameSync`). 마이그레이션 후 레거시 파일 삭제.
- E7. `{username}-default` 외 임의 sessionId로 첫 요청 → 자동 생성 없음, 404.
- E10. `eventActor.inFlight` 또는 `turnActor` 큐에 처리 중 이벤트가 남아있는 상태에서 shutdown이 호출되면 해당 이벤트는 유실될 수 있다. `flushPersistence`는 state만 동기화하며 actor 큐 비우기를 보장하지 않는다. 현재 코드가 이 전제를 강제하지 않는다. Known Limitation.
- E8. SessionManager에서 없는 id로 `get()` 호출 → `null` 반환.
- E9. EphemeralSession의 `flushPersistence()` 호출 → no-op (NOOP 반환). 데이터 손실 없음(애초에 저장 안 함).
- E11. `POST /sessions`의 `type` 파라미터는 현재 `SESSION_TYPE` 화이트리스트 검증 없이 그대로 전달. 임의 문자열 통과 가능 — Known Gap.
- E13. **관리자 CLI로 유저 삭제(`user-store.removeUser`) 시 해당 `userId`의 Memory가 orphan으로 남는다**. mem0 저장소에는 userId 기준 데이터가 그대로 유지되므로, 같은 username이 재등록되면 이전 유저의 메모리가 노출될 수 있다. 현재는 (a) `removeUser`에서 `memory.clearAll(username)` 호출, 또는 (b) `~/.presence/data/{username}/` 디렉토리 전체 삭제로 수동 해결해야 한다 — Known Gap.
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
- E6 → (자동화 테스트 없음) ⚠️ 레거시 마이그레이션 경로
- E4 → `packages/core/test/core/turn-concurrency.test.js`
- I11 → `packages/tui/test/scenarios/session-switch.scenario.js` (세션 전환 후 StatusBar 표시)
- I12 → (직접 테스트 없음) ⚠️ unknown 슬래시 커맨드 차단 단위 테스트 없음

## 관련 코드

- `packages/infra/src/infra/sessions/session.js` — Session 알고리즘 골격 (Template Method)
- `packages/infra/src/infra/sessions/ephemeral-session.js` — EphemeralSession (scheduled/agent 공통)
- `packages/infra/src/infra/sessions/user-session.js` — UserSession (persistence, scheduler, job 툴)
- `packages/infra/src/infra/sessions/session-manager.js` — 세션 생명주기 관리
- `packages/infra/src/infra/sessions/index.js` — Session.create 팩토리
- `packages/infra/src/infra/user-context.js` — UserContext (세션 포함)
- `packages/server/src/server/session-api.js` — 소유권 검증, 자동 생성, REST 엔드포인트
- `packages/server/src/server/ws-handler.js` — WS join 시 소유권 검증

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
