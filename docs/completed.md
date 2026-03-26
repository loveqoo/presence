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
