# Presence 테스트 시나리오

2526 tests, 46 test files.

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

### State + Hook (`test/infra/state.test.js`, `test/infra/hook.test.js`, `test/infra/reactiveState.test.js`) — 30 tests

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

### Plan 파서 (`test/core/plan.test.js`) — 79 tests

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

### Prompt 빌더 (`test/core/prompt.test.js`) — 39 tests

- planSchema: type enum (plan, direct_response), 6개 op type
- formatToolList: 도구 목록 포맷, 빈 목록, required 표시
- buildPlannerPrompt: system + user 메시지, response_format, 메모리 섹션
- formatMemories, buildMemoryPrompt: 메모리 포맷팅

### Assembly + Budget + History (`test/core/assembly.test.js`) — 108 tests

- measureMessages: 메시지 배열 토큰 측정
- flattenHistory: 턴 → user/assistant 메시지 변환
- fitHistory: 토큰 예산 내 이력 fitting (최신 우선)
- fitMemories: 남은 예산으로 메모리 fitting
- buildIterationBlock: iteration context 조립 (full/summarized)
- assemblePrompt 통합: budget 기반 단계적 fitting, assembly metadata
- Conversation history: rolling window, source filtering, truncation

### 에이전트 턴 (`test/core/agent.test.js`) — 154 tests

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
- Either.catch, Either.fold 사용
- validateExecArgs: required 필드 검증
- validateRefRange: RESPOND ref, ASK_LLM ctx 범위 검사
- validateStepFull: Either Kleisli 합성

**Invalid plan shapes (12종):**
- tool_calls, unknown type, plan without steps, empty steps, empty object, 관계없는 객체
- null, 숫자, 배열, direct_response without/null/numeric message

**통합:**
- direct_response: 정상 응답, turnState idle, lastResult 저장
- plan 실행: Incremental Planning, iteration 반복
- Conversation history: source=user만 저장, truncation 적용
- responseFormat: json_object
- JSON 파싱 실패 → finishFailure, parse error detail
- safeRunTurn: null state 안전, 상태 복구
- createAgent: buildTurn 주입, 기본값 fallback

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

### Tool Registry (`test/infra/tools.test.js`) — 9 tests

- register/get/list: 도구 등록, 이름으로 조회, 전체 목록
- 파라미터 스키마 검증

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

### Memory Graph (`test/infra/memory.test.js`) — 82 tests

- addNode, findNode (Maybe), addEdge, query (depth 1/2)
- recall: 키워드 매칭, 연결 노드 확장
- tier 관리: getByTier, removeByTier, promoteNode
- removeNodes(predicate): 노드 제거 + 고아 엣지 정리
- 영속화: lowdb 저장/복원, MemoryGraph.fromFile

**임베딩 통합:**
- embedPending: 벡터 부여, model/dimensions/timestamp/hash 기록
- 이미 임베딩된 노드 건너뜀, 해시 불일치 → 재임베딩
- embed 실패 → 건너뛰고 계속
- 모델/차원 변경 → 재임베딩, 모두 동일 → 건너뜀
- 차원 불일치 벡터 → 검색에서 제외 (NaN 방지)
- 하이브리드 recall: 벡터 + 키워드 병합
- recall without embedder → 빈 배열
- 영속화 라운드트립: episodic 추가 → save → reload → recall

**중복 방지:**
- conversation: 같은 label hash → 기존 노드 갱신
- entity: label + data hash → 기존 반환
- working tier: 중복 허용
- cross-tier: semantic 기존 노드에 episodic 추가 시 기존 반환

### Memory Hook Integration (`test/infra/memory-hook.test.js`) — 18 tests

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

### Local Tools (`test/infra/local-tools.test.js`) — 26 tests

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
- calculate: 수식 평가

**메타데이터:**
- 6개 도구 등록, 필수 필드 존재
- file_write, shell_exec description에 APPROVE 명시

---

## Phase 6: 터미널 UI (Ink)

### UI Components (`test/ui/app.test.js`) — 143 tests

- StatusBar: status/turn/memoryCount 렌더링, error 상태
- ChatArea: user/agent 메시지, tag, 빈 목록
- SidePanel: 에이전트 목록, 상태 표시
- MarkdownText: 마크다운 렌더링
- PlanView: 계획 단계 시각화
- ToolResultView: 도구 결과 표시
- deriveStatus selector: working/error/idle 판정
- deriveMemoryCount selector: 배열 길이, 없으면 0

### Interactive UI (`test/ui/interactive.test.js`) — 29 tests

- StatusBar: idle/working 상태 렌더링, 활동 텍스트, 가시성 플래그
- ChatArea: 메시지 표시
- App 컴포넌트: 전체 앱 렌더링 + 상태 통합

### History Compaction (`test/core/compaction.test.js`) — 91 tests

**순수 함수:**
- extractForCompaction: threshold/keep 기반 분리, 경계 조건
- buildCompactionPrompt: 이전 요약 포함/미포함, 시스템 메시지 분기
- createSummaryEntry: summary marker, 타임스탬프, 랜덤 suffix
- migrateHistoryIds: 레거시 항목 ID 부여

**통합:**
- placeholder 삽입 → 비동기 요약 → 교체
- epoch 기반 /clear 충돌 방지
- rolling window: MAX_HISTORY 상한 유지
- 요약 실패 시 placeholder 제거, remaining 유지

---

## 통합 테스트

### Phase 5 Integration (`test/integration/phase5.test.js`) — 23 tests

**Heartbeat → Event → Agent:**
- heartbeat emit → event hook → agent.run 호출, 올바른 prompt
- working 중 이벤트 큐잉 → idle 후 처리

**Plan DELEGATE → Registry → Local Agent:**
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

### Config (`test/infra/config.test.js`) — 44 tests

- mergeConfig: 중첩 병합, 배열 교체, 빈 override → 기본값
- readConfigFile: 없는 파일 → {}, 유효 JSON → 파싱, 무효 JSON → {} + 경고
- loadInstanceConfig: instanceId 필수, 파일 없으면 기본값, 3단 머지 체인 (DEFAULTS → server.json → instances/{id}.json → env)
- loadInstancesFile: 필수 파일, Zod 검증, 빈 instances 배열 → 에러
- loadClientConfig: 필수 파일, Zod 검증, 기본 locale
- env override: PRESENCE_MAX_RETRIES, PRESENCE_TIMEOUT_MS, 비숫자 무시

### Auth UserStore (`test/infra/auth-user-store.test.js`) — 39 tests

- addUser: 첫 사용자 admin, 중복 거부, 비밀번호 8자 미만 거부, 잘못된 username 거부
- verifyPassword: 정확/부정확/존재하지 않는 사용자
- findUser/listUsers: 조회, passwordHash 미노출
- removeUser: 삭제 후 없음, 존재하지 않는 사용자 에러
- changePassword: tokenVersion bump, refreshSessions 전체 삭제, 새 비밀번호 동작
- refreshSessions: 추가/확인/제거/전체 폐기 (탈취 감지)

### Auth Token (`test/infra/auth-token.test.js`) — 41 tests

- sign/verify: 정상 토큰, 잘못된 서명, 만료, 잘못된 iss/aud
- 엣지: null, undefined, 빈 문자열, 4-part 문자열
- secret.json: 자동 생성, 파일 권한 0600, 멱등성
- TokenService: access token (sub, roles, iss, aud, exp), refresh token (jti, tokenVersion, type)
- cross-instance: 다른 인스턴스 토큰 거부
- PRESENCE_JWT_SECRET env override

### Auth Provider (`test/infra/auth-provider.test.js`) — 24 tests

- authenticate: 성공, 잘못된 비밀번호, 존재하지 않는 사용자 (타이밍 공격 방지)
- null/빈 입력 처리
- tokenVersion 변경 후 인증
- Refresh token rotation 전체 흐름: 로그인 → 갱신 → 이전 jti 폐기 → 폐기된 jti 재사용 → 탈취 감지

### Auth E2E (`test/server/auth-e2e.test.js`) — 38 tests (network)

- AE1-AE3: 미인증 401, 로그인 성공 (accessToken + HttpOnly 쿠키), 로그인 실패 (사용자 존재 미노출)
- AE4-AE6: 인증된 요청 정상, 잘못된 토큰 401, 만료 토큰 401
- AE7-AE9: Refresh rotation + 새 토큰, 폐기된 jti 탈취 감지, 비밀번호 변경 후 refresh 401
- AE10-AE12: Logout (쿠키 만료 + jti 폐기), /api/instance authRequired, Rate limiting 429
- AE13-AE14: WS 미인증 4001 close, WS 인증 init 수신

### Persistence (`test/infra/persistence.test.js`) — 15 tests

- save → restore: 데이터 보존
- 빈 restore → null
- debounce: 마지막 값만 저장
- connectToState: 상태 변경 시 자동 저장
- try-catch 래핑: I/O 실패 시 크래시 방지

### Persona (`test/infra/persona.test.js`) — 13 tests

- 기본값 병합, 저장/복원, 도구 필터

### Logger (`test/infra/logger.test.js`) — 8 tests

- info/warn/error 레벨, 설정 변경

---

## 회귀 테스트

### LLM Malformed Output (`test/regression/llm-output.test.js`) — 70 tests

- 잘못된 JSON: trailing text, 구조 오류, 불완전 JSON
- 에이전트가 malformed 응답을 graceful하게 처리 (크래시 없음)
- extractJson: `<think>` 태그 등 JSON 앞 텍스트 제거

### Tool Handler Defense (`test/regression/tool-defense.test.js`) — 34 tests

- 모든 도구 핸들러에 null, undefined, 빈 문자열, 잘못된 타입 입력
- 에러 throw (크래시 아님) 확인

### Plan Fuzz (`test/regression/plan-fuzz.test.js`) — 57 tests

- validatePlan: 랜덤 plan 구조 → 항상 Either 반환 (throw 금지)
- safeJsonParse: 모든 입력 → Either 반환 (throw 금지)

### E2E Scenario (`test/regression/e2e-scenario.test.js`) — 62 tests

- 경로 정규화: 절대경로 → 허용 디렉토리 상대경로
- 전체 에이전트 파이프라인: planner → parse → validate → (retry) → execute → finish
- 다양한 시나리오: 파일 읽기, 셸 명령, 멀티스텝, 승인, 위임

---

## 오케스트레이터

### ChildManager (`test/orchestrator/child-manager.test.js`) — 11 tests

- createChildManager: API 인터페이스 존재 확인 (forkInstance, stopInstance, restartInstance, getStatus, listStatus, shutdownAll)
- listStatus: 초기 빈 배열
- getStatus: 존재하지 않는 인스턴스 → null
- stopInstance/restartInstance: 존재하지 않는 인스턴스 → no-op / null

### Orchestrator E2E (`test/orchestrator/orchestrator-e2e.test.js`) — 33 tests (network)

**기본 인프라 (OE1-OE3):**
- 오케스트레이터 시작 → 관리 API 응답, 인스턴스 목록
- 인스턴스 fork → 서버 프로세스 기동 확인
- /api/instance 헬스 엔드포인트: id, status, uptime

**관리 API (OE4-OE6):**
- 여러 인스턴스 상태 목록
- 인스턴스 중지/시작: 프로세스 종료 → 접속 불가 → 재기동 → 접속 복구
- 인스턴스 restart: 중지 + 시작 일괄 처리

**인스턴스 격리 (OE7-OE9):**
- 두 인스턴스에 병렬 chat → 독립 응답, 독립 turn
- 인스턴스별 설정 분리: 서로 다른 LLM model 확인
- disabled 인스턴스: fork 안 됨, 관리 목록에 미포함

**WebSocket (OE10):**
- 인스턴스 직접 WS 연결 → init 메시지 수신

---

## 멀티-인스턴스 Live 테스트

### Multi-Instance Live E2E (`test/e2e/multi-instance-live.test.js`) — 86 tests (수동 실행)

> 실제 LLM + 실제 오케스트레이터 대상. `npm start` 후 별도 실행.

**기본 인프라 (ML1-ML3):** 관리 API, 헬스(uptime), 설정 분리(apiKey 미노출)

**대화 + 도구 (ML4-ML6):** 실제 LLM 응답, file_list 도구 실행, 멀티턴 컨텍스트 유지

**격리 (ML7-ML9):** 인스턴스간 대화 격리, 히스토리 독립, 세션간 대화 격리

**동시성 (ML10-ML11):** 다른 인스턴스 병렬 chat, 같은 인스턴스 다른 세션 병렬 chat

**슬래시 커맨드 (ML12-ML14):** /tools, /status 인스턴스별 동작, /clear 격리 확인

**WebSocket (ML15-ML17):** init, state push(turn + turnState), 멀티 클라이언트

**세션 CRUD (ML18-ML19):** 생성/대화/삭제 lifecycle, 삭제 후 404

**에러/경계 (ML20-ML23):** 빈 입력 400, 잘못된 JSON → 에러 후 정상 유지, 존재하지 않는 인스턴스 404, 복잡한 입력 후 idle 복귀

**운영 (ML24-ML25):** 오케스트레이터 restart API → 서비스 복구, 재시작 후 chat 정상
