# Presence — 구현 플랜 v2

개인 업무 대리 에이전트 플랫폼. Free Monad 기반 FP 아키텍처.

> 설계 문서: [docs/architecture.md](docs/architecture.md)
> 완료 이력: [docs/completed.md](docs/completed.md)

## 진행 중 Phase

### Phase 7: 서버-클라이언트 분리 + 세션 관리

**목표**: 서버는 24/7 상시 실행, 클라이언트(터미널/브라우저)는 뷰만 렌더링.
세션별 격리(history, todos, events)로 계층 에이전트의 기반 마련.

#### 분리 기준

| 전역 (서버 1개) | 세션별 |
|---|---|
| LLM 클라이언트 | ReactiveState |
| mem0 (장기 기억) | TurnActor, EventActor |
| MCP 서버 연결 | CompactionActor, BudgetActor, DelegateActor |
| JobStore (SQLite) | MemoryActor (recall context) |
| AgentRegistry | Agent 인스턴스 |
| SchedulerActor | conversationHistory, todos, events queue |
| config, logger | PersistenceActor (ephemeral 세션은 no-op) |

#### WS 프로토콜

```json
// client → server
{ "type": "join", "session_id": "user-default" }
{ "type": "input", "session_id": "user-default", "payload": "..." }
{ "type": "approve", "session_id": "user-default", "payload": { "approved": true } }
{ "type": "cancel", "session_id": "user-default" }

// server → client
{ "type": "init", "session_id": "user-default", "state": {...} }
{ "type": "state", "session_id": "user-default", "path": "turnState", "value": {...} }
```

#### Phase A: bootstrap() 분리 — 동작 변경 없음 ✅

- [x] `createGlobalContext(configOverride?)` 추출 — LLM, mem0, MCP, jobStore, agentRegistry, config, logger
- [x] `createSession(globalCtx, { persistenceCwd? })` 추출 — state, actors, agent, handleInput/approve/cancel
- [x] `bootstrap()` = `createGlobalContext` + `createSession` 조합으로 교체 (하위 호환)
- [x] 기존 테스트 전체 통과 확인 (2015 passed, 0 failed)

#### Phase B: SessionManager + 멀티 세션 서버 ✅

- [x] `src/infra/session-manager.js` 신규 — `create / get / list / destroy`
- [x] `SchedulerActor`: `eventActor` 직접 참조 → `onDispatch(jobEvent)` 콜백으로 교체
- [x] `src/server/index.js` — session-aware 라우팅, `createSessionBridge(sessionManager, wss)`
- [x] REST: `/api/sessions/:id/chat|state|approve|cancel` (기존 `/api/chat` 하위 호환 유지)
- [x] 서버 기동 시 `user-default` 세션 자동 생성 + persistence restore
- [x] 테스트: 세션 생성/소멸, 세션 격리 (2030 passed, 0 failed)

#### Phase C: Ink 씬 클라이언트 ✅

- [x] `src/infra/remote-state.js` — WS 기반 상태 어댑터 (get/hooks.on/off 인터페이스, useAgentState 그대로 동작)
- [x] `src/main.js` — 서버 자동 감지 → 없으면 spawn → `runRemote()` (WS 상태 + REST 커맨드)
- [x] `handleInput/approve/cancel` → REST POST 경유
- [x] `--local` 플래그: in-process `runLocal()` 모드 유지
- [x] 테스트 전체 통과 (2030 passed, 0 failed)

#### Phase D: 세션 정리 + 스케줄러 ephemeral 세션 ✅

- [x] 스케줄러: 잡 실행 시 `sessionManager.create({ type: 'scheduled', id: runId })` → `job_done/fail` 후 `sessionManager.destroy(runId)`
- [x] 유저 세션 idle timeout 지원 (`idleTimeoutMs` 설정)
- [x] 세션 종료 시 history + todos + events 정리 (mem0 장기 기억은 보존)
- [x] 테스트: ephemeral 세션 생명주기, idle timeout 소멸 (2041 passed, 0 failed)

---

## 완료된 Phase

### Phase 8: 계층적 에이전트 (Supervisor 패턴) ✅

- [x] `SESSION_TYPE.AGENT` — 영속성 없음, schedulerActor 없음, job 툴 없음
- [x] `config.agents` — 서브 에이전트 선언적 정의 (name, description, capabilities)
- [x] `src/server/index.js` — config.agents → AGENT 세션 생성 + agentRegistry 등록
- [x] `Delegate` Op — Free Monad DSL, DelegateInterpreter (local/remote)
- [x] `agentRegistry.list()` lazy — 세션 생성 후 등록된 에이전트도 프롬프트에 포함
- [x] 테스트: delegate.test.js (29), supervisor-session.test.js (24), supervisor.test.js (60) — 총 113 assertions

## 미착수 Phase

## TODO

- ~~**메모리 임베딩 관심사 분리**~~ → [완료 기록](docs/completed.md#메모리-임베딩-관심사-분리)

- ~~**메모리 검색 인덱스**~~ → [완료 기록](docs/completed.md#메모리-검색-인덱스)

- ~~**메모리 무효화**~~ → [완료 기록](docs/completed.md#메모리-무효화)

- ~~**프로퍼티 기반 테스트**~~ → [완료 기록](docs/completed.md#프로퍼티-기반-테스트)

- ~~**embedPending 병렬화**~~ → [완료 기록](docs/completed.md#embeddingpending-병렬화)

- ~~**테스트 유틸 라이브러리화**~~ → [완료 기록](docs/completed.md#테스트-유틸-라이브러리화)

- ~~**경계 스키마 검증 (Zod 활용)**~~ → [완료 기록](docs/completed.md#경계-스키마-검증-zod-활용)

- ~~**프롬프트를 데이터로**~~ → [완료 기록](docs/completed.md#프롬프트를-데이터로)

- ~~**MCP 툴 지연 로딩 (lazy tool selection)**~~ → [완료 기록](docs/completed.md#mcp-툴-지연-로딩)

- ~~**`/clear` 후 budget 미갱신 버그**~~ → [완료 기록](docs/completed.md#clear-후-budget-미갱신-버그)

- ~~**report 중간 이터레이션 누락**~~ → [완료 기록](docs/completed.md#report-중간-이터레이션-누락)

- ~~**validateExecArgs 툴 존재 검증**~~ → [완료 기록](docs/completed.md#validateexecargs-툴-존재-검증)

- ~~**persistence restore() 구조 검증**~~ → [완료 기록](docs/completed.md#persistence-restore-구조-검증)

- ~~**`_debug.*` 상태 상한 설정**~~ → [완료 기록](docs/completed.md#debug-상태-상한-설정)

- ~~**Actor 에러 로깅 폴백**~~ → [완료 기록](docs/completed.md#actor-에러-로깅-폴백)

- ~~**mergeSearchResults 단일 패스**~~ → [완료 기록](docs/completed.md#mergesearchresults-단일-패스)

- ~~**MemoryActor 동시성 안전**~~ → [완료 기록](docs/completed.md#memoryactor-동시성-안전)

- ~~**SQLite 기반 메모리 저장소 (mem0 SDK)**~~ → [완료 기록](docs/completed.md#mem0-sdk-통합)


## 운영 결정

| 결정 | 내용 | 이유 |
|------|------|------|
| history source 필터링 | `conversationHistory`는 `source === 'user'` 성공 턴만 저장 | heartbeat/event 턴이 대화 맥락을 오염시키지 않도록 |
| prompt assembly budget | budget 기반 단계적 fitting (system → history → memories) | 고정 크기 컨텍스트 안에서 최신 대화를 우선 보존 |
| embedder null 처리 | embedder 없으면 memory recall 빈 배열 반환 | 키워드 단독 검색은 noise가 많아 오히려 해로움 |
| history rolling window | 상한 20턴 + budget fitting으로 추가 축소 | LLM 컨텍스트 효율성, 오래된 대화는 가치 감소 |

### FP 라이브러리 활용 판단

| 항목 | 판단 | 이유 |
|------|------|------|
| `Either.catch()` (config.js) | **적용** | agent.js `safeJsonParse`와 일관된 패턴 |
| prompt.js `pipe()` | 보류 | 안정화 단계에서 불필요한 변경 |
| state.js `Maybe` 체인 | 유지 | hot path, 성능 우선 |
| `Writer` monad (tracing) | 보류 | fun-fp-js WriterT 필요 |
| `Reader` monad (DI) | 유지 | 현재 클로저 기반이 더 직관적 |

## 핵심 제약

- **조사 먼저**: "선행 조사" 칼럼이 비어있지 않으면, 구현 전에 해당 스펙/논문을 확인
- **Op 이름은 직관적으로**: `askLLM`, `executeTool`, `updateState` — 설명 불필요
- **Free Monad는 인프라**: 프로그램 형태는 바뀔 수 있지만 Free + Interpreter는 유지
- **State 변경은 Op으로**: 명령형 mutation 금지. 프로그램에서 선언, 인터프리터에서 반영
- **부수 효과는 Hook으로**: 로깅, 영속화, 알림 등은 프로그램이 아닌 Hook에서 처리

## 검증 방법

```bash
node test/run.js                    # 전체 테스트 (mock 기반, LLM 불필요)
node test/manual/live-llm.test.js   # 실제 LLM 테스트 (로컬 MLX 서버 필요)
node src/main.js                    # 앱 실행
```
