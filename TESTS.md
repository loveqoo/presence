# Presence 테스트 시나리오

994 tests, 33 test files.

```bash
npm test              # 전체 실행
node test/core/agent.test.js   # 개별 파일 실행
```

---

## Phase 1: 코어

### Op ADT (`test/core/makeOp.test.js`, `test/core/op.test.js`) — 84 tests

- makeOp 팩토리: tag, data, next, Functor symbol, map은 continuation에 적용
- DSL 함수: askLLM, executeTool, respond, approve, delegate, observe, updateState, getState, parallel, spawn
- askLLM: messages 배열 필수, 비배열 → TypeError
- 모든 Op: Free.liftF로 리프트, responseFormat/context 보존

### State + Hook (`test/infra/state.test.js`, `test/infra/hook.test.js`, `test/infra/reactiveState.test.js`) — 27 tests

- createState: get/set/snapshot, 경로 기반 접근 (dot notation), deepClone 독립성
- createHooks: on/off/fire, 와일드카드 매칭, 재귀 방지 (MAX_DEPTH)
- createReactiveState: set 시 hook 자동 발화, hooks 객체 노출

### Test Interpreter (`test/interpreter/test.test.js`) — 17 tests

- 기본 핸들러: AskLLM → mock 응답, ExecuteTool → mock 결과, Respond → message 전달
- UpdateState/GetState: state 객체 연동
- 커스텀 핸들러 오버라이드, throw → Task.rejected, 알 수 없는 Op → rejected
- log 축적: tag + data 기록

### Free + Interpreter 통합 (`test/core/free-integration.test.js`) — 14 tests

- Free.of → Pure, Free.liftF → Impure
- chain 합성, runWithTask로 실행
- updateState → getState 라운드트립

### Plan 파서 (`test/core/plan.test.js`) — 69 tests

**유틸리티:**
- resolveRefs: 1-based 인덱스, null → 빈 배열, 범위 초과 → 필터
- resolveStringRefs: $N 치환, 없으면 유지
- resolveToolArgs: 문자열만 치환, 숫자 유지

**Step 검증 (Either):**
- validateStep: op 존재, 문자열 여부, opHandlers 등록 여부
- argValidators: EXEC → tool 필수, ASK_LLM → prompt 필수, RESPOND → ref 또는 message 필수
- APPROVE → description 필수, DELEGATE → target + task 필수
- LOOKUP_MEMORY → query는 string이거나 생략

**Plan 실행:**
- direct_response → Either.Right(responded message)
- Single EXEC → 결과 배열
- Multi-step (EXEC → ASK_LLM → RESPOND): ctx 참조, ref 참조
- Unknown op → Either.Left, short-circuit (이후 step 실행 안 됨)
- Empty steps → Either.Right([])
- RESPOND 잘못된 ref → Either.Left
- EXEC without tool → Either.Left (PLANNER_SHAPE, not INTERPRETER)

**LOOKUP_MEMORY:**
- 쿼리 필터링, 대소문자 무시, non-string 메모리 처리
- 메모리 없음 → 빈 배열, 매칭 없음 → 빈 배열

**ASK_LLM:**
- context 있으면 전달, 없으면 undefined
- 빈 ctx → undefined, 범위 초과 → undefined

### Prompt 빌더 (`test/core/prompt.test.js`) — 27 tests

- planSchema: type enum (plan, direct_response), 6개 op type
- formatToolList: 도구 목록 포맷, 빈 목록, required 표시
- buildPlannerPrompt: system + user 메시지, response_format, 메모리 섹션
- buildFormatterPrompt: 결과 포맷

### ReAct 루프 (`test/core/react.test.js`) — 63 tests

**순수 함수:**
- appendToolRound: assistant + tool 메시지 추가, tool_call_id, JSON 직렬화
- classifyResponse: string → Right, tool_call → null, multi-tool → Left, empty → Left
- buildInitialMessages: 메모리 → system 메시지, 빈 메모리 → user만

**루프 실행:**
- 도구 없이 직접 답변 → 1회 LLM 호출
- 단일 도구 → 2회 LLM (요청 + 답변)
- 다중 iteration → 반복 도구 호출
- maxSteps 초과 → Either.Left(REACT_MAX_STEPS)
- toolCalls 2개 이상 → Either.Left(REACT_MULTI_TOOL)

**턴 상태:**
- 성공 → turnState=idle, lastTurn=success
- maxSteps 실패 → turnState=idle, lastTurn=failure
- multi-tool 실패 → lastTurn=failure
- tool/LLM 실패 → safeRunTurn catch → INTERPRETER error kind
- 메모리 context.memories → LLM 첫 호출에 system 메시지로 포함

### 에이전트 턴 (`test/core/agent.test.js`) — 127 tests

**상태 전이 ADT:**
- beginTurn → turnState=working(input)
- finishSuccess → lastTurn=success, turnState=idle
- finishFailure → lastTurn=failure, turnState=idle
- 실패 후 성공 → lastTurn이 success로 교체

**Either 기반 파싱/검증:**
- safeJsonParse: 유효 JSON → Right, 무효 → Left(PLANNER_PARSE)
- validatePlan: direct_response, plan, null, non-string message, empty steps, unknown type
- chain: safeJsonParse.chain(validatePlan) — parse 실패 시 short-circuit

**구조 검증:**
- settleError/turnTransitions/applyViaFree 완전 제거
- Either.catch, Either.fold 사용
- createAgentTurn 내부 try/catch 없음 (Either로 대체)
- finishSuccess/finishFailure 상호 독립

**Invalid plan shapes (12종):**
- tool_calls, unknown type, plan without steps, empty steps, empty object, 관계없는 객체
- null, 숫자, 배열, direct_response without/null/numeric message

**통합:**
- direct_response: 정상 응답, turnState idle, lastResult 저장
- plan 실행: planner + formatter 2회 LLM, ExecuteTool 호출
- turnState hook: working → idle 전이
- responseFormat: json_object
- JSON 파싱 실패 → finishFailure, parse error detail
- safeRunTurn: null state 안전, formatter 실패 복구
- bare runWithTask: 안전망 없이 turnState stays working
- createAgent: buildTurn 주입 (Plan/ReAct 전략 교체), 기본값 fallback

---

## Phase 2: 실제 연동

### LLM 클라이언트 (`test/infra/llm.test.js`) — 20 tests

- chat: messages 전달, responseFormat 전달, tools 변환
- tool_calls 응답: toolCalls 배열 반환
- 에러: HTTP 상태 코드, 네트워크 실패, no choices
- timeout: AbortController 기반

### Production Interpreter (`test/interpreter/prod.test.js`) — 48 tests

- AskLLM: LLM chat 호출, responseFormat 전달, context 주입
- ExecuteTool: handler 호출, async handler, unknown tool → rejected
- Respond, Approve, UpdateState, GetState: 기본 동작
- tool_calls: 구조 반환

**Delegate:**
- local agent → DelegateResult.completed
- unknown agent → DelegateResult.failed
- local agent throws → failed (not interpreter exception)
- remote agent completed → output 반환 (mock fetch)
- remote agent 네트워크 실패 → failed
- remote submitted → delegates.pending에 등록
- no agentRegistry → failed
- 통합: plan DELEGATE step → registry → local run → result

**Parallel:**
- allSettled: 성공 + 실패 혼합 → [{status, value/reason}]
- 빈 배열 → []

### Traced Interpreter (`test/interpreter/traced.test.js`) — 14 tests

- trace 축적: tag, timestamp, duration
- 에러 시 entry.error 기록
- inner interpreter 위임

### Dry-run Interpreter (`test/interpreter/dryrun.test.js`) — 13 tests

- stub 반환, plan 축적
- op별 summary 생성 (dispatch object)
- 커스텀 stub 오버라이드

### Input Handler (`test/infra/input.test.js`) — 18 tests

- 줄 단위 입력: buffer → onLine 콜백
- Bracketed Paste Mode: paste 시작/끝 감지, onPaste 콜백
- flush: 잔여 buffer 처리

### REPL (`test/core/repl.test.js`) — 28 tests

- 일반 입력 → agent.run 호출, 결과 반환
- /quit, /exit → running = false
- agent 에러 → onError, null 반환
- /status → turnState, turn, lastTurn 표시
- /help → 명령어 목록
- /tools → 등록 도구 목록
- /agents → 등록 에이전트 목록
- /todos → TODO 목록
- /events → 큐 + dead letter 현황
- COMMANDS export

---

## Phase 3: MCP + 도구 확장

### MCP Integration (`test/infra/mcp.test.js`) — 40 tests

**extractContent:**
- text 추출, 복수 text 합치기, non-text 알림, 빈 배열, null

**ensureObjectSchema:**
- valid → passthrough, non-object/null/undefined → fallback

**validateSchema → Either:**
- valid → Right, null/non-object → Left

**connectMCPServer:**
- 도구 이름 prefix ({serverName}_{toolName})
- handler → callTool 위임, 원본 이름(prefix 없이) 서버에 전송
- schema fallback: non-object → object
- close: client + transport 정리, idempotent
- connect/listTools 실패 → 에러 전파 + cleanup

### Embedding (`test/infra/embedding.test.js`) — 26 tests

**순수 함수:**
- dotSimilarity: 동일/직교/반대 벡터
- topK: 상위 K개, 부족하면 전체
- toEmbeddingText: label + input + output, null 스킵
- textHash: 결정적, 다른 텍스트 → 다른 해시
- mergeSearchResults: 합집합, 높은 점수 우선, 겹치면 max

**createEmbedder:**
- custom embedFn → 직접 사용
- openai provider: mock fetch, dimensions 반영
- API 에러: 상태 코드 포함
- unknown provider → throw

### Memory Graph (`test/infra/memory.test.js`) — 70 tests

- addNode, findNode (Maybe), addEdge, query (depth 1/2)
- recall: 키워드 매칭, 연결 노드 확장
- tier 관리: getByTier, removeByTier, promoteNode
- 영속화: lowdb 저장/복원, MemoryGraph.fromFile

**임베딩 통합:**
- embedPending: 벡터 부여, model/dimensions/timestamp/hash 기록
- 이미 임베딩된 노드 건너뜀, 해시 불일치 → 재임베딩
- embed 실패 → 건너뛰고 계속
- 모델/차원 변경 → 재임베딩, 모두 동일 → 건너뜀
- 차원 불일치 벡터 → 검색에서 제외 (NaN 방지)
- 하이브리드 recall: 벡터 + 키워드 병합
- recall without embedder → 키워드만
- embedPending null → no-op
- 영속화 라운드트립: episodic 추가 → save → reload → recall
- findNode Nothing

### Memory Hook Integration (`test/infra/memory-hook.test.js`) — 16 tests

- 턴 시작 → 메모리 recall → context.memories 주입
- 턴 종료 → working memory 정리
- 턴 종료 → episodic 기록 추가
- 실패 턴 → episodic 미저장, working 정리됨
- 성공 후 실패 후 → 성공만 저장
- Promotion: 3회 이상 언급 → episodic → semantic

---

## Phase 4: Heartbeat + 이벤트 소스

### Event System (`test/infra/events.test.js`) — 43 tests

**createEventReceiver:**
- emit → 큐에 추가, id/receivedAt 자동 부여
- 연속 emit → 유실 없이 누적, 순서 보존
- custom id 보존

**wireEventHooks:**
- idle 시 큐 head 처리 → agent.run 호출
- working 시 → 큐에 대기
- agent.run 실패 → deadLetter (error + stack trace)

**wireTodoHooks:**
- event.todo 있으면 → TODO 생성 (sourceEventId)
- event.todo 없으면 → 미생성
- 멱등성: 같은 이벤트 재처리 → 중복 없음

**순수 함수:**
- withEventMeta: id, receivedAt 부여, 기존 id 보존
- eventToPrompt: prompt > message > type fallback
- todoFromEvent: Maybe — Just(todo) / Nothing
- isDuplicate: sourceEventId 비교

### Heartbeat (`test/infra/heartbeat.test.js`) — 19 tests

- start → emit 호출, type=heartbeat, prompt 전달
- stop → 더 이상 emit 안 함
- 중복 start 방지
- emit 에러 → onError, 계속 실행
- setTimeout 자기 스케줄링 → 중첩 없음
- coalesce: 큐에 미처리 heartbeat → skip
- 큐 비우면 다시 emit
- 다른 타입 이벤트 큐 → heartbeat 영향 없음
- inFlight heartbeat → skip
- inFlight 다른 타입 → 영향 없음

---

## Phase 5: Multi-Agent + A2A

### Agent Registry (`test/infra/agent-registry.test.js`) — 27 tests

**DelegateResult shape:**
- completed: mode, target, status, output
- submitted: taskId, output null
- failed: error message, mode null

**Registry:**
- register + get → Maybe(entry)
- get unknown → Nothing
- list, has
- remote agent: type, endpoint
- local agent: run 함수 호출

### A2A Client (`test/infra/a2a-client.test.js`) — 50 tests

**순수 함수:**
- extractArtifactText: text 추출, null/빈 배열, non-text
- buildTaskSendRequest: JSON-RPC 2.0, message/send method
- buildTaskGetRequest: tasks/get method
- responseToResult: completed/submitted/working/failed/rpc error/invalid

**sendA2ATask:**
- completed 즉시 반환, submitted taskId, HTTP 에러, 네트워크 에러, JSON-RPC 에러
- 요청 형식: endpoint, jsonrpc 2.0, method, task text

**getA2ATaskStatus:**
- completed → output, 네트워크 에러 → failed

**wireDelegatePolling:**
- idle 시 pending 폴링 → completed → emit + pending 제거
- still working → pending 유지
- 주기적 타이머: 첫 tick working → 두 번째 tick completed → emit
- polling 가드: 동시 실행 방지

### Local Tools (`test/infra/local-tools.test.js`) — 23 tests

**경로 검증:**
- isPathAllowed: 빈 목록 → 허용, 내부 → 허용, 외부 → 거부
- sibling-prefix 우회 방지 (/tmp/project-evil)
- 정확한 디렉토리 매칭

**도구별:**
- file_read: 내용 읽기, 없는 파일 → 에러, 접근 거부 → 에러
- file_write: 쓰기 + 읽기 확인, 접근 거부
- file_list: 파일/디렉토리 구분, 없는 경로
- web_fetch: handler 존재, url 필수
- shell_exec: stdout 캡처, 실패 명령 → 에러

**메타데이터:**
- 5개 도구 등록, 필수 필드 존재
- file_write, shell_exec description에 APPROVE 명시

---

## 통합 테스트

### Phase 5 Integration (`test/integration/phase5.test.js`) — 23 tests

**Step 29 — Heartbeat → Event → Agent:**
- heartbeat emit → event hook → agent.run 호출, 올바른 prompt
- working 중 이벤트 큐잉 → idle 후 처리

**Step 30 — Plan DELEGATE → Registry → Local Agent:**
- planner DELEGATE step → registry 조회 → local run → 결과
- 실패 delegate → plan 결과에 포함

**Parallel:**
- 여러 Free 프로그램 병렬 실행

**이벤트 FIFO:**
- 3개 이벤트 → idle 전이마다 하나씩 순서대로

**deadLetter:**
- agent.run 실패 → 에러 기록, 원본 이벤트 보존

---

## 인프라

### Config (`test/infra/config.test.js`) — 22 tests

- mergeConfig: 중첩 병합, 배열 교체, 빈 override → 기본값
- readConfigFile: 없는 파일 → {}, 유효 JSON → 파싱, 무효 JSON → {} + 경고
- loadConfig: 파일 없으면 기본값, 파일 있으면 병합, 기본값 shape 검증

### Persistence (`test/infra/persistence.test.js`) — 8 tests

- save → restore: 데이터 보존
- 빈 restore → null
- debounce: 마지막 값만 저장
- connectToState: 상태 변경 시 자동 저장

### Persona (`test/infra/persona.test.js`) — 13 tests

- 기본값 병합, 저장/복원, 도구 필터

### Logger (`test/infra/logger.test.js`) — 8 tests

- info/warn/error 레벨, 설정 변경

### UI Components (`test/ui/app.test.js`) — 28 tests

- StatusBar: status/turn/memoryCount 렌더링, error 상태
- ChatArea: user/agent 메시지, tag, 빈 목록
- SidePanel: 에이전트 목록, 상태 표시
- deriveStatus selector: working/error/idle 판정
- deriveMemoryCount selector: 배열 길이, 없으면 0
