# Presence — 완료 이력

## Phase 1~5: 코어 구현

| Phase | Steps | 내용 | 상태 |
|-------|-------|------|------|
| **Phase 1** | 1-12 | 코어 (Op, State, Plan, Agent) | ✅ |
| **Phase 2** | 13-19 | 실제 연동 (LLM, Interpreter, REPL) | ✅ |
| **Phase 3** | 20-23 | MCP + 도구 (MCP, 메모리, 임베딩) | ✅ |
| **Phase 4** | 24-26 | Heartbeat + 이벤트 | ✅ |
| **Phase 5** | 27-29 | Multi-Agent + A2A | ✅ |

**Phase 1-5 이후 추가 구현:**
- 상태 전이 ADT (Phase/TurnResult/ErrorInfo)
- Incremental Planning Engine (plan/react 통합, formatter 제거)
- Config 시스템 (파일 + env override + maxRetries/timeoutMs)
- i18n (ko/en)
- 로컬 도구 6개 (file_read/write/list, web_fetch, shell_exec, calculate)
- 다층 검증 (safeJsonParse → validatePlan → validateExecArgs → validateRefRange → RESPOND 위치)
- 회귀 테스트 4종 + Live LLM 테스트

## Phase 6: 터미널 UI (Ink)

| Step | 파일 | 내용 |
|------|------|------|
| **31** | `src/ui/hooks/useAgentState.js` | State → UI 바인딩 React Hook |
| **32** | `src/ui/components/StatusBar.js` | 상단 status bar 개선 |
| **33** | `src/ui/components/PlanView.js` | iteration/step 인라인 시각화 |
| **34** | `src/ui/components/ChatArea.js` | 대화 영역 개선 |
| **35** | `src/ui/components/InputBar.js` | 입력 바 개선 |
| **36** | `src/ui/components/SidePanel.js` | 컨텍스트 패널 |
| **37** | `src/ui/components/ApprovePrompt.js` | APPROVE 인라인 프롬프트 |
| **38** | `src/ui/App.js` | 레이아웃 매니저 + 사이드 패널 토글 |
| **39** | `src/main.js` | readline → Ink 앱 전환 |

**Phase 6 이후 추가 구현:**
- Prompt Assembly + Budget fitting (단계적 fitting: system → history → memories)
- Conversation History (rolling window max 20턴, source filtering, truncation)
- Iteration context compaction (이전 plan/results 요약하여 rolling context)
- TranscriptOverlay 디버그 (assembly metadata: budget/used/dropped)
- Config: prompt budget 설정
- config.js: `Either.catch()` 패턴 적용
- 코드 품질 리팩터링: 정책 상수 통합, MemoryGraph encapsulation, 에러 경계 정리

## Phase A-D: 구조 리팩토링

**Phase A:** Hook → Actor 전환. MemoryActor, CompactionActor, PersistenceActor 도입.

**Phase B:** 턴 라이프사이클 명시화. beginTurn → no-op, turnState=working을 safeRunTurn으로 이동.

**Phase C:** StateT(Task) 인터프리터 + 상태 경합 해소.
- 인터프리터 인터페이스: `{ interpret: Op → StateT(Task), ST }`
- safeRunTurn: snapshot → runFreeWithStateT → applyFinalState (원자적 커밋)
- /clear + compaction 경합: epoch 기반 방어
- Parallel UI 격리: ref-count depth counter

**Phase D:** Hook → Actor 통합 — 모든 비동기 비즈니스 로직을 Actor로 일원화.
- EventActor, BudgetActor, DelegateActor 추가
- Hook은 상태변경→Actor 메시지 브릿지만 담당

## 완료된 TODO

### 메모리 임베딩 관심사 분리

`MemoryGraph.embedPending(embedder)`가 저장소 클래스 안에서 임베딩까지 수행하던 구조를 분리.

- `MemoryGraph`: `embedPending` 제거 → `setVector(nodeId, data)` 추가. 노드/엣지 CRUD + 검색만 담당.
- `src/infra/memory-embedder.js` (신규): `createMemoryEmbedder(embedder)` → `embedPending(graph, opts)`. 임베딩 판단·실행·벡터 쓰기 담당.
- `src/infra/actors.js`: MemoryActor init에 `memoryEmbedder` 주입, 'embed' 케이스 위임.

### 메모리 검색 인덱스

`nodes.filter()` 선형 스캔 → 역인덱스(term → Set\<nodeId\>)로 교체.

- `_index: Map<term, Set<nodeId>>` + `_nodeTerms: Map<nodeId, string[]>` (unindex용)
- 생성자에서 기존 노드 전체 재인덱스 (파일 로딩 지원)
- `addNode`: 신규 노드 `_indexNode`
- `removeNodes` / `removeNodesByTier` / `removeOlderThan` / `pruneByTier` / `clearAll`: `_unindexNode` 호출
- `_keywordSearch`: `this._index.get(kw)` O(1) 조회로 교체
- 동작 변화: substring 매칭 → 정확 term 매칭 (keyword는 vector 검색 보조용이라 허용)

### 메모리 무효화

사실 기반 메모리가 오래되면 LLM을 오도하는 문제 해결. 두 메커니즘 도입.

**`expiresAt` TTL 필터:**
- `addNode({ ..., expiresAt: null })` — null이면 영구 유효
- `recall` 시 `!n.expiresAt || n.expiresAt > now` 조건으로 만료 노드 제외
- label 기반 dedup도 `expiresAt` 갱신 (재저장 시 TTL 연장)

**출처 기반 자동 갱신 (source dedup):**
- `addNode({ ..., source: { tool, toolArgs } })` — 도구명 + 인자를 `textHash`로 저장
- 같은 `source`로 재호출 시 기존 노드 label/data/expiresAt/vector 갱신 (새 노드 미생성)
- `source`가 있으면 label 기반 dedup 건너뜀 (source가 identity)

### 프로퍼티 기반 테스트

[fast-check](https://github.com/dubzzz/fast-check)으로 FP 타입 모나드/펑터 법칙과 MemoryGraph 구조적 불변량을 랜덤 입력으로 검증. `test/core/fp-laws.test.js` (29 assertions).

**검증 범위:**
- Maybe, Either, Free, Task: 펑터 항등/합성 + 모나드 좌항등/우항등/결합법칙
- Free: Pure 전용 프로그램으로 법칙 검증 (`noRunner` 주입)
- Task: `fc.asyncProperty` 사용
- MemoryGraph: working tier no-dedup, episodic dedup (label+data), source dedup, findNode 왕복, pruneByTier 정확도, removeNodes 고아 엣지 정리

### MCP 툴 지연 로딩

MCP 툴 전체를 프롬프트에 직접 노출하던 방식 → `mcp_search_tools` / `mcp_call_tool` 메타 툴 2개로 대체. MCP 서버가 수십 개의 툴을 제공해도 프롬프트에는 2줄만 추가됨.

- `mcp_search_tools(query)`: 키워드로 MCP 툴 검색 → 이름+설명 목록 반환
- `mcp_call_tool(tool_name, tool_args)`: 검색으로 찾은 툴 이름으로 실제 호출
- `APPROVE_RULES`에 `mcp_call_tool` 추가 (MCP 툴은 쓰기/비가역 작업 가능)
- `src/main.js`: `toolRegistry.register(tool)` 직접 등록 제거 → `allMcpTools` 배열에 수집 후 메타 툴 핸들러에서 참조

### `/clear` 후 budget 미갱신 버그

`/clear` 실행 시 `context.conversationHistory`만 초기화되어 상태바 budget % 와 이전 메모리 recall 결과가 잔존하던 문제 수정.

- `src/ui/App.js`, `src/server/index.js` `/clear` 핸들러에 추가 초기화:
  - `context.memories` — 이전 recall 결과 제거
  - `_debug.lastTurn/lastPrompt/lastResponse/opTrace/recalledMemories/iterationHistory` — UI 상태 리셋

### report 중간 이터레이션 누락

멀티 이터레이션 턴에서 마지막 이터레이션만 `_debug.lastTurn/lastPrompt/lastResponse`에 남아 중간 과정이 유실되던 문제 수정.

- `src/core/agent.js`: 이터레이션마다 `_debug.iterationHistory` 배열에 `{ iteration, prompt, response, assembly, ... }` 누적. 새 턴 시작 시 초기화.
- `MANAGED_PATHS`에 `_debug.iterationHistory` 추가 (`applyFinalState` 경유)
- `src/ui/hooks/useAgentState.js`: `iterationHistory` 상태 추가 구독
- `src/ui/report.js`: `## Iterations` 섹션 추가 — 이터레이션별 parsed type, step count, assembly used, prompt 크기, LLM 응답 출력

### 프롬프트를 데이터로

문자열 하드코딩 프롬프트 → 구조화된 섹션 객체(`{ id, content }`).

- `section(id, content)` — frozen 섹션 ADT
- `PROMPT_SECTIONS` — 4개 named section: `ROLE_DEFINITION`, `OP_REFERENCE`, `APPROVE_RULES`, `PLAN_RULES`
- `renderSections(sections)` — 섹션 배열 → 문자열 조인
- `assemblePrompt`: `fixedSections.join('\n\n')` → `renderSections(activeSections)`. 동적 섹션(tools, agents, user_rules, custom_role)도 섹션으로 표현
- `_assembly.sections`: 실제 포함된 섹션 ID 배열 — 어떤 섹션이 조립됐는지 감사 가능
- 회귀 테스트 (test 19-24): 섹션 구조, 알려진 ID, 콘텐츠 서명, 불변성, `_assembly.sections` 추적
- 하위 호환: `ROLE_DEFINITION` 등 문자열 상수 `.content` 별칭으로 유지

### 테스트 유틸 라이브러리화

47개 테스트 파일에 중복 정의된 `assert`/`passed`/`failed` 보일러플레이트를 `test/lib/assert.js`로 추출.

- `assert(condition, msg)`, `assertDeepEqual(a, b, msg)`, `check(label, run)`, `summary()` — 공통 패턴
- `eqMaybe`, `eqEither`, `runTask`, `eqTask` — FP 타입 동등성 헬퍼 (fp-laws.test.js에서 추출)
- `summary()`: `\n${passed} passed, ${failed} failed` 출력 + 실패 시 `process.exit(1)`
- 47개 파일 모두 마이그레이션. 로컬 보일러플레이트 제거.

### embeddingPending 병렬화

`createMemoryEmbedder.embedPending`의 순차 `await` → 배치 기반 병렬화.

- `createMemoryEmbedder(embedder, { concurrency = 3 })` — concurrency 옵션 추가
- `for` 루프를 `concurrency` 크기 배치로 분할, 배치마다 `Promise.allSettled` 실행
- 실패 격리: 한 노드 실패가 같은 배치 내 다른 노드에 영향 없음
- 에러 로그에 `nodeId` 유지 (`batch[j].id` 인덱스 접근)
- rate limit(429) 포함 모든 에러 → 경고 로그 + 노드 스킵 (기존 동작과 동일)
- 기존 테스트 93개 전부 통과

### 경계 스키마 검증 (Zod 활용)

시스템 경계(config 로딩, 도구 인자)에 Zod 스키마 검증 도입. 수작업 `typeof` 체크를 선언적 스키마로 교체.

**`src/infra/config.js`:**
- `ConfigSchema` — 전체 config 구조 선언적 스키마 (llm, embed, heartbeat, delegatePolling, prompt 등)
- `loadConfig`: 병합 후 `ConfigSchema.safeParse` — 실패 시 `console.warn` + fallback (non-fatal)
- `ConfigSchema` export 추가

**`src/infra/local-tools.js`:**
- `FileReadArgs`, `FileWriteArgs`, `FileListArgs`, `WebFetchArgs`, `ShellExecArgs`, `CalculateArgs` — 도구별 Zod 스키마
- `parseArgs(schema, args, toolName)` — 공통 파싱 헬퍼. 필수 인자 누락 → i18n `arg_required` 메시지. 타입/값 오류 → descriptive 에러.
- 빈 문자열 방어: path/url/command/expression에 `.min(1)` 적용. content(file_write)는 빈 문자열 허용.
- Zod v4 호환: `.issues` (구 `.errors`), `received === undefined` (구 `=== 'undefined'`)
- `maxLines: 0` → "no limit" 의미 유지: 스키마 `.nonnegative()`, 핸들러 `if (maxLines)` (truthy check)

### validateExecArgs 툴 존재 검증

`agent.js`의 `validateExecArgs`가 레지스트리에 없는 툴을 `Either.Right(true)`로 통과시키던 문제 수정.

- `if (!toolDef) return Either.Right(true)` → `Either.Left(ErrorInfo('EXEC: unknown tool: ...', ERROR_KIND.PLANNER_SHAPE))`
- 실행 시점 `[ERROR] Unknown tool` 대신 플랜 검증 시점에 오류 포착 → 즉시 재시도 유도
- `test/regression/e2e-scenario.test.js` 테스트 10c 추가 (미등록 툴 → PLANNER_SHAPE, 툴 미실행)

### Actor 에러 로깅 폴백

`src/infra/actors.js`의 `if (logger) logger.warn(...)` 패턴을 `(logger || console).warn(...)` 으로 교체.

- CompactionActor, EventActor, DelegateActor 3곳 적용
- logger가 주입되지 않은 테스트/임베디드 환경에서도 Actor 핸들러 실패가 콘솔에 출력됨

### mergeSearchResults 단일 패스

`src/infra/embedding.js`의 `mergeSearchResults`가 이미 Map 기반 O(n+m) 구현으로 최적화되어 있음. 추가 변경 불필요 — TODO 해소.

---

- **Actor 기반 비동기 처리**: Phase D에서 완료. MemoryActor, CompactionActor, PersistenceActor, EventActor, BudgetActor, DelegateActor 도입.
- **StateT 기반 인터프리터 리팩토링**: Phase C에서 완료. StateT(Task) 인터프리터 + 원자적 상태 커밋.
- **레이어 의존성 정리**: tokenizer, path 등 공유 유틸을 `src/lib/`로 추출.
- **인터프리터 합성 구조**: Interpreter 클래스 + tag 기반 라우팅, 7개 단일 관심사 인터프리터.
- **Plan 정규화 파이프라인**: 선언적 규칙 배열 `[normalizeExecToDelegate, normalizeExecToApprove, ...]` + `rules.reduce`.

### persistence restore() 구조 검증

`src/main.js`의 state restore 블록 정리.

- `migrateHistoryIds`를 `Array.isArray` 조건 없이 무조건 적용 (함수 내부에서 비배열 처리)
- context를 두 번 set하던 패턴 → `{ ...restored.context, conversationHistory: migrated }` 단일 set으로 통합
- `_compactionEpoch` 증가도 context 복원 블록 안으로 이동

### _debug 상태 상한 설정

`src/core/policies.js`에 `DEBUG.MAX_ITERATION_HISTORY = 10` 추가.

- `agent.js`의 `_debug.iterationHistory` 갱신 시 `slice(-MAX_ITERATION_HISTORY)` 적용
- maxIterations가 크게 설정되거나 미래에 확장되어도 디버그 이력이 최대 10개로 유지

### MemoryActor 동시성 안전

Actor 메시지 경계에서 pending 노드 스냅샷을 선행 캡처.

- `src/infra/memory-embedder.js`: `embedNodes(pending, graph, opts)` 메서드 추가 + `needsEmbedding(node)` 인스턴스 메서드 추가. `embedPending`은 내부적으로 `embedNodes` 위임.
- `src/infra/actors.js` `embed` 핸들러: `graph.allNodes().filter(...)` 를 Task 생성 이전(메시지 경계)에 실행 → Task 내 async 작업이 스냅샷에만 의존
- Actor 큐 직렬화와 함께 이중 방어: removeWorking이 embed Task 완료 전에 실행될 수 없으며, 가설적 경합이 발생해도 스냅샷 노드만 처리

### mem0 SDK 통합

`mem0ai/oss` npm 패키지로 메모리 시스템 교체. 인프로세스 실행, better-sqlite3 기반 로컬 SQLite.

- `src/infra/mem0-memory.js` (신규): `Mem0Adapter` 클래스 (sync cache API 래핑) + `createMem0Memory` 팩토리. `Memory` import는 동적 (`await import('mem0ai/oss')`) — ESM/CJS interop 문제 회피.
- `src/infra/actors.js`: `MemoryActor`를 mem0 기반으로 교체. `recall` → `mem0.search`, `save` → `mem0.add`, 나머지 (`embed/prune/promote/removeWorking/saveDisk`) → no-op.
- `src/main.js`: `createMemoryGraph` → `createMem0Memory`, MemoryActor 파라미터 변경.
- `test/infra/actors.test.js`: M1~M8 MemoryActor 테스트 전면 재작성 (mem0 mock 기반).
- Embedding 정책 유지: embed API 없으면 메모리 비활성 (`createMem0Memory` null 반환).

### Reader / Writer / State 모나드 도입

클로저 기반 DI 34개를 Reader 모나드로 전환하고, Writer/State 모나드를 도입하여 FP 아키텍처 강화.

**Phase 1 — auth-middleware.js Reader:**
- 8개 함수 Reader 전환: `loginHandlerR`, `refreshHandlerR`, `logoutHandlerR`, `authMiddlewareR`, `authenticateWsR`, `issueTokensR`, `validateRefreshChainR`, `rotateRefreshTokenR`
- Reader 합성: `rotateRefreshTokenR`이 내부에서 `issueTokensR` 체이닝
- 레거시 브릿지: `const createX = (deps) => xR.run(deps)` 단일 라인 위임

**Phase 2 — config.js State:**
- `buildConfig(layers)` — `State.modify` chain으로 config 머지 파이프라인 구성
- `mergeConfig(mergeConfig(...))` 중첩 호출 → `buildConfig([...]).run(DEFAULTS)[0]`

**Phase 3 — traced.js Writer:**
- 가변 `trace[]` → `Writer.of(null)` + `Writer.tell([entry])` 축적
- 외부 API: `getTrace()` (방어적 복사) / `resetTrace()`
- 내부 mutable accumulator, 외부에는 함수 인터페이스만 노출

**Phase 4 — actors.js Reader:**
- 8개 factory Reader 전환: `memoryActorR`, `compactionActorR`, `persistenceActorR`, `turnActorR`, `eventActorR`, `emitR`, `budgetActorR`, `delegateActorR`

**Phase 5 — session-factory.js Reader 합성:**
- `create*` 직접 호출 → `xR.run(sessionEnv)` 전환

**Phase 6 — server/index.js Reader:**
- `sessionBridgeR`, `sessionRoutesR` Reader 전환
- `authEnv` 패턴으로 인증 미들웨어 Reader 실행

**FP 코딩 규칙 강제:**
- CLAUDE.md: 모나드 역할 경계 테이블, Reader/State/Writer 사용 규칙
- `.claude/rules/`: 4개 경로별 규칙 파일 (fp-monad, interpreter, test, auth-web)
- `.claude/hooks/validate-fp.sh`: PreToolUse hook — 클로저 DI, trace.push, mergeConfig 중첩 차단

**검증:** 브릿지 동치 테스트 (35 assertions) + 전체 mock 테스트 2556 passed + live E2E 121 passed

### infra 패키지 리팩토링

클래스 + Reader 전환, #private, 매직 넘버 상수화, 관심사별 폴더 분리.

- `embedding.js` → `embedding/` (provider.js, openai-provider.js, cohere-provider.js, embedder.js, search.js)
- `mcp.js` → `mcp/` (transport.js, connection.js, schema.js, content.js)
- `llm.js` → `llm/` (llm-client.js, sse-parser.js)
- `memory.js`, `persistence.js`, `persona.js`, `events.js` — 클래스 전환 + #private
- `policies.js` — EMBEDDING, LLM, TODO 상수 통합
- 테스트 파일 workspace별 분리 (`test/infra/` → `packages/infra/test/`)

### server 패키지 리팩토링

PresenceServer facade 클래스 도입, Express 파이프라인 가시화, 파일 통합.

- `PresenceServer` — static create + #boot + shutdown facade
- `#mountRoutes()` — Express 미들웨어/라우트 순서를 한 곳에서 관리
- `UserContextManager`, `SessionBridge`, `WsHandler` — 클래스 전환 (#private)
- `auth-setup.js` → Router 반환 패턴 (expressApp 변이 제거)
- `session-api.js` → Router 반환 + 슬래시 커맨드 테이블 디스패치 흡수
- `constants.js` — WS_CLOSE, INACTIVITY_TIMEOUT_MS, WATCHED_PATHS 통합
- 삭제: `legacy-routes.js`, `slash-commands.js`, `ws-bridge.js`, `scheduler.js` (9개 → 6개)
- `SESSION_TYPE` import 경로 수정 (pre-existing bug)

### tui 패키지 리팩토링

React custom hook 추출, RemoteSession 클래스 전환.

- `useAgentMessages` — App.js의 4개 useEffect (history, budget, toolResults, 턴 초기화) 통합
- `useSlashCommands` — handleInput + slashCtx 16필드 디스패치 캡슐화
- `RemoteSession` — runRemote의 mutable state 6개 + 클로저 5개 → 클래스 응집
- App.js Score 224 → 139 (렌더 트리 조립에만 집중)

**규칙 추가:**
- `refactor.md` — React/Ink 컴포넌트 리팩토링 규칙 (custom hook 추출 기준)
- `validate-fp.sh` — TUI 패키지 클로저 DI 검사 제외
- `check-filename.sh` — ui/ 하위 PascalCase 허용

### TUI 시나리오 live e2e 테스트

실제 서버 + 실제 LLM 기반 사용자 시나리오 검증. 4단계 40+ assertions.

- `live-helpers.js` — 공용 인프라 (connect, setup, sendAndWait, waitIdle)
- `tui-live.test.js` — 기능 단위 검증 15개 (인증 모드 호환)
- `tui-scenario.test.js` — 시나리오 검증:
  - 1단: 멀티턴 맥락, 도구 연쇄, /clear, 디렉토리 탐색, 계산 연쇄
  - 2단: 다중 파일 비교, 조건 분기, 4턴 체인, 도구+판단, 커맨드 혼합
  - 3단: 에러 복구, 6턴 맥락(5/5 기억), 도구 3턴 연쇄, /clear+도구, 커맨드↔대화 교차
  - 4단: streaming, 멀티 이터레이션, approve, cancel, 세션 전환

---

## Phase F: 티켓 레지스트리 + UX 정비 + 메시지 아키텍처 (2026-04)

Phase 6 까지 핵심 기능 완성 이후, **운영 중 드러난 UX 마찰점과 스펙 Known Gap 을
체계적으로 해소하는 사이클**. 전역 티켓 레지스트리를 단일 진실의 원천으로 도입하고
묶음 단위로 FP/KG 를 resolved 했다. 총 75개 티켓 (FP 61 + KG 14) 전부 해소.

### F-0. 티켓 레지스트리 인프라

- `docs/tickets/REGISTRY.md` — FP (UX friction point) + KG (spec Known Gap) 전역 ID 관리
- `scripts/tickets.sh next-id/list/check` — 번호 부여 + pre-commit 정합성 검증
- `.claude/rules/tickets.md` — 에이전트/개발자 절차 정의

### F-1. 승인 + 에러 가시성 클러스터 (FP-01/02/03/16/22/46)

- ApprovePrompt 위험도 분류 (High/Medium/Low) + 거부 피드백 + HIGH_RISK_PATTERNS 21개
- StatusBar errorHint(ERROR_KIND) 표시
- disconnected 배너 + close code 별 사유 분기 (4001/4002/4003)

### F-2. 진입 / 로그인 / 상태 인지 (FP-04/09/15/17~21/23/24/25/26/29/30/36/37)

- resolveServerUrl source 표시 (`--server` / `PRESENCE_SERVER` / 기본값)
- promptPassword 완전 mute, 로그인 실패 횟수 표시
- 스트리밍 중 "thinking → 응답 중" 라벨 전환, `_reconnecting` publish
- idle 전용 키 힌트 라인, Esc 임시메시지 닫기
- `/sessions switch` 성공 피드백, InputBar disabled 상태 메시지

### F-3. 슬래시 커맨드 한글화 + 인식 정확성 (FP-05~08/10~13/27/28/31~35/38~45/47~51 + KG-02/03/05/06)

- 모든 슬래시 커맨드 출력 i18n (한글 고정 문자열 제거)
- 알 수 없는 `/xxx` 슬래시 커맨드 에이전트 전달 차단 (FP-42)
- `/copy` 크로스플랫폼 클립보드 (darwin/linux/win32), `/report` 디스크 저장
- MarkdownText 이탤릭/목록/링크 렌더링 확장
- TranscriptOverlay 5개 탭 (FP-27/KG-08 포함), ChatArea truncation 배너
- POST /sessions SESSION_TYPE 검증, PRESENCE_DIR 변경 감지, authRequired=false dead code 제거

### F-4. 데이터 품질 / 디버그 보강 (KG-09~13, FP-52~60)

- LLM max_tokens 파이프라인 + truncation 탐지 + retry 원인 표시
- `safeJsonParse` 절단 휴리스틱 + TurnError.truncated
- Planner retry iteration index (retryAttempt) + 에러 레이블 개선
- SERP URL 구조적 차단 (`policies.js` 정규식 6개 + validatePlan)
- Plan 마지막 ASK_LLM + RESPOND 누락 거부 (I9), `$N` 미구현 규칙 제거
- StatusBar retry 활동 i18n, TranscriptOverlay Iterations 탭 스크롤 스태킹 해소

### F-5. 메인 뷰 깜빡임 해소 (FP-58)

- StatusBar spinner 제거 (`setInterval(100ms)` → 정적 `◌`)
- streaming chunk 200ms trailing throttle (16Hz → 5Hz)
- `<Static>` 패턴 제거 → 동적 렌더 + MAX_VISIBLE 제한 (/clear 양립)
- `PRESENCE_TRACE_PATCHES=1` 진단 인프라, measure-writes.js / measure-patches.js

### F-6. 메시지 아키텍처 재설계 (FP-61 / KG-14)

**배경**: `useAgentMessages` 의 이중 출처(서버 conversationHistory + TUI addMessage)
로 순서 역전 / abort 메시지 소실 / cancel flash 가 누더기 패치 4회 반복. 근본 원인을
구조적으로 해소.

**핵심 변경**:
- `history-writer.js` 신규 pure helpers (makeEntry / appendAndTrim / markLastTurnCancelled)
  — Free 경로와 Imperative 경로가 공유
- `TurnLifecycle` 재구성: Free API (recordSuccess/recordFailure/finish) +
  Imperative API (recordAbortSync/recordFailureSync/appendSystemEntrySync/
  markLastTurnCancelledSync). Session 이 소유해 planner/executor/turn-controller 가 동일 인스턴스 공유.
- `HISTORY_ENTRY_TYPE` (turn/system) — SYSTEM entry (cancel/approve 기록) 가 prompt
  assembly 및 compaction 에서 배제 (INV-SYS-1)
- `executor.recover` — abort OR 조건 (`err.name === 'AbortError' || isAborted()`) 으로
  `recordAbortSync` 또는 `recordFailureSync` 분기
- `turn-controller` — turnState 확인 + handleInput finally 의 fallback markLastTurnCancelled
  로 race condition 해소 (cancel 이 applyFinalState 진행 중 도착해도 플래그 부여)
- `_pendingInput { input, ts }` + TUI useMemo dedup — 같은 input 연속 질문 정상 렌더
- `_toolTranscript` append-only 로 세션 누적 tool 로그, `/clear` 때만 초기화
- `clearDebugState` (INV-CLR-1) — history / pendingInput / toolTranscript / budgetWarning 모두 초기화
- TUI `useAgentMessages` 전면 재작성 — addMessage 제거 → addTransient/clearTransient/optimisticClearNow
- StatusBar ABORTED semantics — 사용자 ESC 취소는 error 가 아닌 idle 로 표시

**스펙**: `docs/specs/tui-server-contract.md` I8/I9/I16 갱신 + INV-SYS-1/2/3, INV-CLR-1,
INV-CNC-1, INV-ABT-1, INV-PND-1, INV-TTR-1 신규. 커버리지 매트릭스 실제 테스트 경로 반영.

**검증**: mock 2654 통과 (history-writer 46, turn-lifecycle 23, turn-controller 23,
e2e TE24~29), live (qwen3.5-35b) tui-live-focus 18 통과.

### F-7. 에이전트 + 플랜 리뷰 워크플로우

- `plan-reviewer` 서브에이전트 — 플랜 파일 Codex adversarial 리뷰
- `code-reviewer` — `.claude/rules/` 기준 코드 규칙 검증
- `spec-guardian` / `ux-guardian` / `user-guide-writer` — 각 영역 문서 소유권 가드
- 문서 소유권 훅 (`check-doc-ownership.sh`) — docs/{specs,ux,guide} 를 가디언에게만 위임
- `codex-rescue` 서브에이전트 — 디버깅/원인분석 Codex 위임

---

## Phase G: FSM 아키텍처 전면 구축 (2026-04-18 ~ 04-20)

배경: Phase F 메시지 아키텍처 재설계(FP-61) 에서 이중 출처 문제를 pure helpers 로 막았지만,
turnState 전이 규칙이 여전히 `turn-controller.js` / `executor.js` / `actors/*` 에 흩어짐.
멀티 UI (TUI + WUI + A2A) 확장 시 race / 거부 규칙이 재발할 위험. **상태 전이를
first-class value 로 표현**하는 FSM 대수를 도입해 근본 해소.

설계 근거: [`docs/archive/fsm.md`](archive/fsm.md) (Transition Algebra 내부 설계)

총 13 Phase, 35+ 커밋. 2654 → 3130 pass (+476 assertion).

### G-1. 대수 정립 — Phase 1~2

- **Phase 1** (Transition Algebra core): `Transition` ADT + `FSM` 타입 + `step` 순수 함수 +
  `product` 조합자 + laws 검증 + `turnGateFSM` 최초 정의. identity/determinism/first-match/
  rejection-stability/product-identity/associativity 법칙 테스트.
- **Phase 2** (Runtime + EventBus): `FsmEventBus` (topic fanout, best-effort delivery) +
  `FSMRuntime` (commit-atomic / publication-best-effort-isolated semantics) 구축. 대수는
  순수, runtime 이 효과/병행성 담당으로 책임 분리.
- **R1 정책 확정** (`stepProduct`): 여러 FSM 이 동시에 판단할 때 **명시적 거부가 수락을 이긴다**.
  no-match 는 non-fatal, explicit reject 만 aggregation 에서 승리.

### G-2. 실제 경로 교체 — Phase 4~5

- **Phase 4** (turnGate swap, single-writer): `TurnState` ADT 전환 →
  `turn-gate-bridge` (FSM → reactiveState projection) → `executor.beginLifecycle/afterTurn/
  recover` 를 runtime 병행 호출 → **완전 single-writer**. `turnController` 가 더 이상
  `turnState` 를 직접 set 하지 않음.
- **Phase 5** (외부 refresh 계약): `versionGen` 분리 + **sortable monotonic stateVersion**
  (clock rollback 방어) → WS broadcast 에 stateVersion 포함 → MirrorState 가 stale
  감지 시 `requestRefresh` → HTTP 응답에 stateVersion 포함. 멀티 클라이언트가 서버를 진실의
  원천으로 받아들이는 프로토콜 완성.

### G-3. 추가 FSM + 합성 — Phase 6~8

- **Phase 6** (approveFSM): `idle / awaitingApproval(description)` 2 상태 +
  `request_approval / approve / reject / cancel_approval` 4 command. `approve-bridge` 가
  Promise resolve preservation (기존 onApprove 계약 유지). 단일 bus + exact topic 구독으로
  간섭 차단.
- **Phase 7** (delegateFSM): `idle / delegating({count})` 2 상태. 당장의 실익은 낮지만
  **구조 일관성** (turnGate / approve 와 동일 interface) 을 우선해서 도입. 이후 SessionFSM
  합성 시 비대칭 폭발 방지.
- **Phase 8** (SessionFSM 합성): `product({turnGate, approve, delegate})` 로 직교 축 통합.
  단일 `sessionRuntime` 이 세 FSM 을 관리 + 단일 `stateVersion` 이 모든 전이 추적. Bridge 는
  `childKey` 옵션으로 product state 에서 자기 축만 추출.

### G-4. 운영 경로 확립 — Phase 9~12

- **Phase 9** (HTTP reject 응답에 snapshot 동봉): reject 된 명령의 클라이언트가 즉시
  reconcile 할 수 있게 `{stateVersion, snapshot}` 포함 → round-trip 감축.
- **Phase 10** (stateVersion 영속화): 세션 snapshot 에 `_fsmVersions` 저장 +
  `runtime.restoreStateVersion` → 재시작 연속성. Phase 4 Debt 해소.
- **Phase 11** (executor fallback 제거): `executor.beginLifecycle/afterTurn/recover` 의
  legacy 경로 삭제. FSM 경로가 유일. `makeTestAgent` / `makeTestExecutor` helper 도입으로
  테스트도 runtime 경로 통일.
- **Phase 12** (sessionRuntime 단일화 + delegate-actor 실제 연결): 세 bridge 가
  `sessionRuntime` 공유. `delegate-actor` 가 `delegateRuntime.submit` / `resolve` 로 실제
  FSM 과 연결 (Phase 7 의 껍데기에 내용 채움).

### G-5. 정리 + 검증 — Phase 13~14

- **Phase 13a** (복잡도 정리 — Params 초과 4 파일): `embedding/provider.js`,
  `jobs/job-store.js`, `jobs/job-tools.js`, `sessions/internal/idle-monitor.js` 의
  constructor 를 `(opts)` 단일 객체로 통일. Params 6~7 → 1.
- **Phase 13b** (수용 가능한 구조): 남은 9 복잡도 위반 (op-handler, session, delegation,
  scheduler-actor, auth/*, tool-registry, jobs/*) 은 재설계 수반 → **의도된 구조** 로
  인정하고 skip.
- **Phase 14** (라이브 LLM 검증): 임시 유저 자동 생성/삭제 패턴을 `live-helpers.js` 에
  통합. `tui-live-focus.test.js` 18/18, `tui-live.test.js` 15/15 통과. FSM 경로
  (pending/cancel/clear/sessions) 실 LLM 환경에서 검증.

### 산출물

주요 파일:
- `packages/core/src/core/fsm/` — `fsm.js`, `runtime.js`, `event-bus.js`, `product.js`,
  `laws.js`
- `packages/infra/src/infra/fsm/` — `turn-gate-fsm.js`, `approve-fsm.js`,
  `delegate-fsm.js`, `session-fsm.js`, 3 개 bridge
- `packages/infra/src/infra/sessions/internal/session-fsm-init.js` — sessionRuntime 배선
- `test/lib/test-agent.js` — `makeTestAgent` / `makeTestExecutor` 공용 helper

설계 원칙 확립:
- **Command-Event 분리** — Command (의도, reject 가능) vs Event (발생 사실, unicast)
- **Commit-atomic / Publication-best-effort-isolated** — state 는 원자 커밋, event 는
  subscriber 하나 실패가 다른 subscriber 를 막지 않음
- **R1 aggregation** — 명시적 거부가 수락을 이긴다. no-match 는 non-fatal
- **구조 일관성 우선** — FSM 전이 규칙이 데이터. 실익이 적어도 동일 인터페이스 유지로
  합성 비대칭 방지

---

## Phase H: 세션별 workingDir 근본 교정 + 웹 도구 품질 개선 (2026-04-21)

배경: Phase 20 전까지 서버는 `process.cwd()` 에 의존해 도구 상대경로를 해석했다.
`npm start --workspace=@presence/server` 로 띄운 서버는 cwd 가 `packages/server/` 이
되어 사용자가 기대하는 프로젝트 루트와 어긋났다 (`tui-scenario.test.js` S4 LLM timeout
근본 원인). 동시에 `web_fetch` 가 HTML 을 raw 로 반환해 LLM 에게 template boilerplate
만 전달하던 FP-62 도 드러났다.

설계 문서: [`docs/archive/fsm.md`](archive/fsm.md) 의 후속으로 workingDir 계약이
`docs/specs/tui-server-contract.md` 에 추가됨.

총 13 단계 + FP-62/63/64 후속. 회귀 3158 → 3203 pass.

### H-1. Phase 20 — 세션별 workingDir 도입

1. **Config migration** — user config 에 `tools.allowedDirs` 가 없으면 서버 최초
   부팅 시 `process.cwd()` 를 1회 저장. 이후 `process.cwd()` 는 세션 의미 결정에
   사용하지 않음
2. **해결 체인** — POST body.workingDir → `allowedDirs[0]` (fallback + pendingBackfill=true)
   → 결정 실패 시 명시적 에러
3. **경계 검증** — workingDir 은 반드시 `allowedDirs` 안쪽. 위반 시 HTTP 400 (POST)
   또는 WS close `4004 WORKING_DIR_INVALID`
4. **WS init payload** — `workingDir` 필드 포함. TUI 가 매 join 시 effective 값 수신
5. **Persistence** — `workingDir` + `pendingBackfill` 를 state.json 에 저장
6. **pendingBackfill 흐름** — 자동 생성 `{user}-default` 세션은 첫 WS join 시 TUI cwd 로
   덮어씀 + 플래그 해제. 이후 기존 값 우선
7. **Tool handler context 확장** — `(args, { workingDir, resolvePath, ... })` subset 주입.
   `resolveInWorkingDir` 순수 함수로 세션 기준 절대경로 해석
8. **Prompt WORKING_DIR 섹션** — system prompt 에 "Current working directory: {dir}"
   힌트. LLM 이 상대경로를 올바르게 조립
9. **TUI 연동** — `MirrorState` 가 `process.cwd()` 를 WS join + POST /sessions body 에
   동봉

### H-2. FP-62 — web_fetch HTML 본문 추출

- 초기 시도: regex 기반 tag strip + Wikipedia 전용 키워드 감지 (may refer to 등).
  사용자 피드백으로 "도메인 특화 금지" 원칙 확립 → 전용 분기 전부 제거
- 최종: `@mozilla/readability` + `jsdom` 도입. Firefox Reader View 알고리즘이 article
  본문만 추출, nav/ad/boilerplate 자동 제거. article 판정 실패 시 `body.textContent`
  fallback
- `analyzeWebFetchResult` 는 범용 신호 (empty / very_short) 만 사용

### H-3. FP-63/FP-64 — Phase 20 UX 감사 후속

- **FP-63** (high resolved): `App.js disconnectedReason` 분기에 `WS_CLOSE.WORKING_DIR_INVALID`
  (4004) 케이스 추가. 배너 원인 ("현재 폴더가 서버의 허용 범위를 벗어났습니다") + 조치
  ("허용된 폴더로 이동한 뒤 TUI 를 다시 실행하세요") 문구 분기. 기존 4001/4002/4003
  하드코드도 `WS_CLOSE.*` 상수 참조로 정리
- **FP-64** (medium resolved): `POST /sessions` 400 응답에 `code` 필드 추가
  (WORKING_DIR_OUT_OF_BOUNDS / WORKING_DIR_NOT_RESOLVABLE / SESSION_CREATE_FAILED).
  TUI cmdNew 가 code 기반 `sessions_cmd.error.*` 한국어 메시지 표시

### H-4. 슬래시 커맨드 복수형 → 단수형 전환

CLI 자원명 관례 (`git branch`, `docker container`) 에 맞춰 breaking change:

| 이전 | 이후 |
|---|---|
| `/tools` | `/tool list` |
| `/todos` | `/todo list` |
| `/sessions` | `/session list` |
| `/sessions new/switch/delete` | `/session new/switch/delete` |

REST endpoint `/api/sessions/...` 는 HTTP 규약 유지. backward alias 없음 (개인 프로젝트
단계). REPL / TUI / 서버 slash 디스패치 / i18n / 가이드 / 테스트 일괄 갱신.

### H-5. 라이브 검증 인프라

- `live-helpers.js` 에 `probeTool(serverInfo, { input, toolName })` helper 추가 —
  connect + chat + toolTranscript 추출 캡슐화
- `test/e2e/live-probes/` 디렉토리 + README + `fp-62-web-fetch-quality.test.js` —
  티켓별 재현 시나리오를 상시 tracked 로 보관
- 라이브 LLM (qwen3.6-35b) 으로 FP-62 재현 → 경고 prefix + Readability 본문 추출 →
  LLM 이 1회 호출로 답변 완료 (6.9s) 확인

### 관련 스펙 / 불변식 추가

`docs/specs/tui-server-contract.md`:
- INV-FSM-SINGLE-WRITER, INV-FSM-R1, INV-VER-MONOTONIC, INV-RFS-STALE, INV-RJT-SNAPSHOT
  (Phase G 후속) + 실제 테스트 커버리지 명시
- workingDir 해결 체인 / pendingBackfill / WS init payload / POST 응답 shape / WS close
  4004 계약화

`docs/specs/data-persistence.md`, `session.md` — workingDir 영속화 / 해결 체인 반영.

### 주요 의존성 추가

- `@mozilla/readability` ^0.6.0 (infra)
- `jsdom` ^29.0.2 (infra)

## Phase I: Cedar 권한 엔진 도입 — 옵션 Y' 최소 + governance v2.2 (2026-04-26)

설계 + 플랜 + 구현이 모두 `feature/cedar-governance-v2` 브랜치에서 atomic 묶음. v1 governance-cedar 의 무한 plan-reviewer 회귀를 메타 결정 명문화 (governance §1.0, cedar-infra §1.0) 로 사전 차단. KG-23 (Op ADT wrapping 부재) 만 명시적 KG 로 연기, KG-24 (호출 정합성) 는 phase 종료와 함께 resolved.

### I-1. 디자인 — 메타 결정 분리

- `governance-cedar.md` v2 → v2.1 → v2.2 — §1.0 메타 결정 (의미론 집중도 = Y "최소") 신설, sub-결정 §1.1~1.3 자동 도출
- `cedar-infra.md` v1 → v1.1 → v1.2 — §1.0 메타 결정 (Y' "최소 인프라") 신설, sub-결정 §1.1~1.9 자동 도출
- 두 문서 모두 codex single-round 리뷰 결함 흡수 후 박힘 (governance 3건, cedar-infra 7건 + KG-23)

### I-2. 플랜 — Pre-1 가용성 + 5 커밋 + 2 회 plan-reviewer 흡수

- `cedar-infra-y-prime.md` v1 → v1.2 → v1.3 — plan-reviewer round 1 (6건) + round 2 (4건 + KG-24) 흡수 + 실제 wasm API 의사코드 정정
- Pre-1 PASS — `@cedar-policy/cedar-wasm@4.10.0` (AWS 공식, sync API, nodejs export, deps 0)

### I-3. 인프라 5 커밋 (CI-Y1~Y7 + UC-Y1/Y2 + SC-Y1a/Y3)

- 커밋 1 (`270a38c`) — wasm dep + `evaluator.js` (Reader.asks DI, stateless cedar.isAuthorized + answer.type 분기 + 런타임 fail-closed)
- 커밋 2 (`e0918f6`) — `boot.js` (3중 parse fail-closed: checkParseSchema/PolicySet/validate) + `policies/00-base.cedar` minimal RBAC seed + `schema.cedarschema`
- 커밋 3 (`b652155`) — `audit.js` JSONL append + 디렉토리 0700 + 파일 0600 자동 보정
- 커밋 4a (`f001622`) — `paths.js` (import.meta.url) + `bootCedarSubsystem` public entry + `PresenceServer.#evaluator` 필드 + admin bootstrap 직후 부팅
- 커밋 4b (`52ef096`) — `UserContext.create` + `UserContextManager` evaluator 필수 인자 (invariant), `test/lib/cedar-mock.js` helper 신규

### I-4. 의미론 통합 2 커밋 (GV-Y1/Y2/Y4/Y5 + AC4b)

- GC1 (`cce021b`) — `submitUserAgent` Cedar enforcement point + STATUS.DENIED + cli.js cmdAgentAdd Cedar boot 통합. GV-Y1.1~1.8 (8 케이스 allow), GV-Y2 (호출 횟수 정합, validate 실패 시 미호출), GV-Y4 (mock deny → 코드 분기 미도달), GV-Y5 (evaluator invariant)
- GC3 (`b114399`) — cli.js `cmdAgentApprove` manual_approve audit (Cedar evaluate 호출 *없음*, 디자인 §1.4 admin override 정합) + `createSubsystemAuditWriter` helper

### 검증 매트릭스 (옵션 Y' enforcement 완전성)

| 항목 | 위치 | 검증 |
|---|---|---|
| CI-Y1/Y2 (RBAC allow) | `cedar-evaluator.test.js` CE1/CE2 | 인프라 |
| CI-Y3 (boot 후 가용) | `server.test.js` SC-Y1a + `cedar-boot.test.js` CB1 | 인프라 |
| CI-Y4 (audit JSONL) | `cedar-audit.test.js` CA1 | 인프라 |
| CI-Y5 (boot fail-closed) | `cedar-boot.test.js` CB2/CB3 | 인프라 |
| CI-Y6 (deny-path 정책 측) | `cedar-boot.test.js` CB4 | 인프라 |
| CI-Y7 (런타임 fail-closed) | `cedar-evaluator.test.js` CE4 | 인프라 |
| GV-Y1 (8 케이스 호출) | `agent-governance.test.js` GV-Y1.1~1.8 | 의미론 |
| GV-Y2 (호출 횟수) | `agent-governance.test.js` GV-Y2 | 의미론 |
| GV-Y3 (의미론 회귀) | `agent-governance.test.js` GV1~GV15 (mock evaluator) | 의미론 |
| GV-Y4 (deny → 분기 미도달) | `agent-governance.test.js` GV-Y4 | 의미론 |
| AC4b (manual_approve audit) | `agent-cli.test.js` AC4b | CLI |

### 후속 KG

- **KG-23** (low/infra, open): Cedar evaluate 가 Op ADT 로 wrapping 안 됨. Y' phase 호출처가 서비스 레이어 (LLM 경계 밖) 라 즉시 위험 0. LLM 이 직접 권한 조회를 트리거하는 시나리오 발생 시 Op 도입.

### 주요 의존성 추가

- `@cedar-policy/cedar-wasm` ^4.10.0 (infra) — AWS 공식, Apache-2.0, sync API

## Phase J: KG-15 admin singleton session 강제 (2026-04-26)

`feature/cedar-governance-v2` 브랜치에 후속 작업으로 추가. 설계 §9.3.5 의 "admin 단일 session 강제" 요구를 옵션 (a) takeover 제거 형태로 구현. concurrent admin approve race 가 새 세션 진입 자체에서 차단됨.

### 변경

- `SessionManager.findAdminSession()` 추가 — SESSION_TYPE.USER 중 agentId 의 username 파트가 reserved 인 첫 entry 검색. tagged union `{ kind: 'present'|'absent', entry }`.
- `canAccessAgent` 옵션 callback `findAdminSession` 수용 + `REASON.ADMIN_SINGLETON: 'admin-singleton'` 추가. `NEW_SESSION` + reserved owner + `present` 결과 → deny.
- `session-api.js` POST `/sessions` 진입점에서 `findAdminSession: () => ctx.sessions.findAdminSession()` 주입.

### 회복 경로

명시 `DELETE /api/sessions/:id` 또는 서버 재시작 (in-memory sessions Map). TTL 자동 만료는 후속 — UserSession idle monitor 미지원 (현재 EphemeralSession 만 지원).

### 테스트

- `agent-access.test.js` AS1~AS5 (canAccessAgent decision)
- `session-manager-routing.test.js` SM-admin1~4 (findAdminSession routing)
- KG-18 spy infra 가 진입점 #1 의 NEW_SESSION 호출 자체는 이미 동적 검증 중이라 통합 테스트 추가 불필요

## Phase K: KG-16 M3 primaryAgentId 적용 (2026-04-26)

`feature/cedar-governance-v2` 브랜치 후속 작업. 모든 USER 세션 agentId 결정이 `config.primaryAgentId` 기반으로 통일됨. 이전엔 4 곳에서 `${userId}/default` 와 `agents/default` 디렉토리가 hardcode 되어 있어, admin 의 `primaryAgentId='admin/manager'` 가 세션 생성에 반영되지 않던 M1 표기를 해소.

### 변경

- `packages/core/src/core/agent-id.js` — `resolvePrimaryAgent(config, fallbackUserId) → { agentId, agentName }` 헬퍼 추가. `config.primaryAgentId` 가 valid canonical form 이면 그대로, 아니면 `${fallbackUserId}/default` fallback (validateAgentId 검증 경유).
- `packages/infra/src/infra/config.js` — `Config.Schema` 에 `primaryAgentId: z.string().optional()` 추가. 이전엔 zod strip 동작으로 admin 의 `primaryAgentId='admin/manager'` 가 런타임 Config 객체에서 제거되던 잠재 버그 동시 해결.
- 4 진입점 hardcode 제거 (모두 `resolvePrimaryAgent` 결과로 agentId + persistence path 결정):
  - `server/index.js` — boot 기본 user-default USER 세션
  - `session-api.js` findOrCreateSession — `{username}-default` lazy 생성
  - `session-api.js` POST `/sessions` — 신규 세션 생성
  - `scheduler-factory.js` onDispatch — legacy null-owner fallback

### 핵심 효과

- admin USER 세션이 정확히 `admin/manager` agentId 사용 (이전: hardcode `admin/default` 로 archived/registry 검사 우회).
- 사용자 정의 primaryAgentId (예: `alice/research`) 가 세션 생성에 반영됨.
- persistence 경로 일관: `users/{username}/agents/{primaryAgentName}/sessions/{sid}/`.

### 테스트

- `packages/core/test/core/agent-id.test.js` PA1~PA6 (resolvePrimaryAgent 단위)
- `packages/server/test/auth-e2e.test.js` AE18 (admin 로그인 + POST `/sessions` → KG-18 spy 로 agentId='admin/manager' 검증)

## Phase L: KG-20 validateAgentId 회귀 정적 검사 (2026-04-26)

`feature/cedar-governance-v2` 브랜치 후속. KG-20 의 우려 ("validateAgentId 미경유 raw 문자열 주입 회귀 검증 부재") 를 KG-18 패턴 미러로 해소.

### 실사 결과 (이미 존재한 방어)

- Session 생성자 — `assertValidAgentId(opts.agentId)` 호출 (`session.js:29`)
- AgentRegistry.register — 동일 호출 (`agent-registry.js:20`)
- resolveDelegateTarget — `validateAgentId` 경유 (Parser→Resolver→Authz §3.6)
- Op.SendA2aMessage 인터프리터 — `assertValidAgentId(to)` 호출
- A2A self card — `validateAgentId(agentId)` 호출
- 단위 테스트: SD11~13 (Session 생성자 throw), RDT1~9 (resolveDelegateTarget) 이미 존재

부족했던 것: **검증 호출 라인이 회귀로 삭제되어도 catch 못 함**.

### 변경

- `test/regression/agent-id-validation-enforcement.test.js` 신규 — INV-AGENT-ID-VALIDATION 정적 검사. 5 사이트가 `agent-id` 모듈 import + `assertValidAgentId`/`validateAgentId` 호출을 모두 가지고 있는지 정적 grep. 누락 시 fail.
- `test/run.js` — Spec invariant static checks 섹션에 신규 테스트 등록.
- `agent-identity.md` — I3 / I10 stale ⚠️ 제거 (이미 단위 테스트 커버), I1 에 회귀 검사 매핑 추가, KG-20 resolved.

### 미적용

- 동적 spy 강화 (validateAgentId 호출 자취 트레이스) — 정적 grep + 단위 테스트 조합으로 회귀 방어 충분. spy 추가는 후속 가치 검토 시.

## Phase M: KG-21 Parser→Resolver→Authz 순서 정적 강제 (2026-04-26)

`feature/cedar-governance-v2` 브랜치 후속. KG-21 의 우려 ("resolver 우회 raw target 이 canAccessAgent 에 직접 들어와도 탐지 불가") 를 KG-18 / KG-20 패턴 미러로 해소.

### 실사 결과

`packages/infra/src/interpreter/delegate.js` 가 정확히 Parser→Resolver→Authz 순서로 호출:
- line 18: `resolveDelegateTarget(f.target, { currentUserId })` (Resolver)
- line 27: `canAccessAgent({ jwtSub, agentId, intent: DELEGATE, ... })` (Authz)

부족했던 것: **호출 순서가 회귀로 뒤바뀌거나 resolveDelegateTarget 이 누락되어도 catch 못 함**.

### 변경

- `test/regression/delegate-order-enforcement.test.js` 신규 — INV-DELEGATE-ORDER 정적 검사. (1) resolveDelegateTarget / canAccessAgent import 존재, (2) 두 함수 호출 존재, (3) resolveDelegateTarget 첫 호출 라인 < canAccessAgent 첫 호출 라인. 주석 라인은 strip 하여 false-positive 차단.
- `test/run.js` — Spec invariant static checks 섹션에 등록.
- `agent-identity.md` — I10 커버리지에 정적 검사 매핑 추가, KG-21 resolved.

### 미적용

- 후속의 두 옵션 (`ResolvedAgentId.__resolved` 마커 / resolver 진입 spy) 은 침습적 — 정적 grep 으로 회귀 방어 충분. 동적 spy 보강은 KG-18 가 이미 DELEGATE intent 의 agentId 자취를 캡처.

## Phase O: KG-17 A2A JWT Bearer 인증 (2026-04-26)

`feature/cedar-governance-v2` 브랜치 후속. A2A 라우터의 caller 인증을 stub (`X-Presence-Caller` 헤더) → JWT Bearer 토큰 서명 검증으로 교체. agent-identity.md I4 의 5 진입점 중 #2 (HTTP `/a2a/*`) 의 인증 미완성을 해소.

### 변경

- `packages/infra/src/infra/auth/policy.js` — `AUTH.A2A_TOKEN_EXPIRY_S = 60`. self-A2A scope (같은 머신 / 같은 secret) 에서 클럭 드리프트 무시 가능, 짧은 만료로 충분.
- `packages/infra/src/infra/auth/token.js` — `createTokenService` 에 `signA2aToken(sub)` / `verifyA2aToken(token)` 추가. 기존 `verify` 헬퍼 (HS256 + exp/iss/aud) 재사용. payload 에 `type: 'a2a'` 박아서 access/refresh 토큰과 분리 — `verifyA2aToken` 은 `payload.type !== 'a2a'` 일 때 `Either.Left('not an a2a token')`.
- `packages/infra/src/infra/agents/a2a-protocol.js` — `JsonRpcErrorCode.AUTH_INVALID = -32002` 추가 (기존 AUTH_MISSING -32000, ACCESS_DENIED -32001 와 정렬).
- `packages/infra/src/infra/agents/a2a-client.js` — `sendTask(target, endpoint, taskText, { callerToken })` 시그니처. callerToken 있으면 `Authorization: Bearer ${callerToken}` 자동 첨부.
- `packages/server/src/server/a2a-router.js` — `mountInvokeRoute` 가 Bearer 토큰 파싱 → `tokenService.verifyA2aToken` (서명/만료/audience/type) → `payload.sub` 를 caller 로 추출 → `canAccessAgent({ jwtSub: caller, intent: DELEGATE })`. 헤더 누락 → 401 AUTH_MISSING. 검증 실패 → 401 AUTH_INVALID. 라우터 부팅 시 `verifyA2aToken` 부재 → throw (fail-closed).
- `packages/server/src/server/index.js` — boot 순서 재배치: `createAuthSetup` 가 `UserContext.create` 보다 먼저 실행 (a2aSigner 주입). `auth.tokenService.signA2aToken` 을 UserContext 에 주입. `createA2aRouter` 호출에 `tokenService` 인자 전달.
- `packages/server/src/server/auth-setup.js` — return shape 에 `tokenService` 노출.
- `packages/server/src/server/user-context-manager.js` — constructor `tokenService` 수용. `getOrCreate` 가 lazy 부트 시 `a2aSigner = (sub) => tokenService.signA2aToken(sub)` 를 새 UserContext 에 주입.
- `packages/infra/src/infra/user-context.js` — `userContext.a2aSigner = opts.a2aSigner ?? null`.
- `packages/infra/src/interpreter/delegate.js` — Reader env 에 `a2aSigner` + `currentUserId` 추가. `runRemote` 가 `a2aSigner(currentUserId)` 로 caller 토큰 발급 → `a2a.sendTask(..., { callerToken })` 첨부.
- `packages/infra/src/interpreter/prod.js` + `session-interpreter.js` + `ephemeral-inits.js` — Reader env 에 a2aSigner 전파 (DI 체인).
- 테스트 A2A1~A2A4 (`auth-token.test.js`): sign/verify 정상 + access 토큰 misuse 거부 + verifyAccessToken 의 type 검사 부재 명시 + malformed.
- 테스트 AI1~AI11 (`a2a-invoke.test.js`): 기존 8 케이스 모두 `'x-presence-caller'` → `Authorization: Bearer ${a2aToken(caller)}` 로 교체. AI2 (헤더 누락 → AUTH_MISSING). AI10 (위조 서명 → AUTH_INVALID). AI11 (access 토큰 오용 → 'not an a2a token').

### 미적용

- `verifyAccessToken` 의 type 검사 미강제 — A2A 토큰을 access 경로로 우회 사용은 별도 보호 (auth middleware 의 roles/mustChangePassword 검증) 에 의존. 향후 강화 옵션. A2A3 테스트로 명시.
- 멀티 머신 간 검증 (peer key registry / mTLS) 은 Phase 2. 현재 self-A2A scope (같은 머신 = 같은 secret) 만 작동.

### 핵심 효과

- A2A 라우터 caller identity 가 stub 헤더에서 위조 불가능한 JWT 서명 검증으로 격상. agent-identity.md I4 5 진입점 중 #2 의 stub 결함 해소.
- access/refresh/A2A 세 토큰 type 의 명시적 분리로 토큰 우회 차단 (type='a2a' 가 아닌 토큰의 A2A 라우터 호출 거부).
- 짧은 만료 (60s) 로 토큰 유출 시 영향 최소화.

## Phase N: KG-22 i18n EN 키 일괄 보강 (2026-04-26)

`feature/cedar-governance-v2` 브랜치 후속. ko.json 223 키 / en.json 132 키였던 91 키 누락을 옵션 (a) (일괄 영어 번역 추가) 로 해소. locale=en 사용자가 동적 humanize 경로에서 받던 한국어 잔재 / raw key 표시 제거.

### 변경

- `packages/infra/src/i18n/en.json` — 91 missing 키 영어 번역 추가. namespace 그룹: `status`, `memory_cmd`, `mcp_cmd`, `sessions_cmd`, `slash_cmd`, `input_hint`, `slash_hint`, `key_hint`, `statusline_cmd`, `plan_op`, `op_phase`, `op_label`, `side_panel`. 기존 KO/EN 키 변경 없음 — 추가만.
- `test/regression/i18n-key-parity.test.js` 신규 — INV-I18N-PARITY 정적 검사. ko.json / en.json flat key 집합 동등성 강제. KO/EN 모두 223 키. missing 발생 시 fail.
- `test/run.js` — Spec invariant static checks 섹션에 등록.

### 미적용

- 옵션 (b) (locale=en dev 로그로 missing 노출) — 정적 parity 검사가 test 단계에서 강제하므로 dev 로그보다 강한 방어. 컴파일 타임 (== test 단계) 차단으로 갈음.

### 핵심 효과

- locale=en 사용자가 동적 prefix 호출 (`a2a.error.${code}`, `op_label.*`, `sessions_cmd.*` 등) 에서 영어 응답을 받음.
- 새 KO 키 추가 시 EN 미갱신 회귀가 INV-I18N-PARITY 로 즉시 catch.
