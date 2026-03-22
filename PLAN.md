# Presence — 구현 플랜 v2

## 배경

개인 업무 대리 에이전트 플랫폼. "작고 세련되게"가 핵심 목표.

### v1에서 배운 것

**유지할 것:**
- Free Monad + Interpreter 분리 — 선언과 실행의 분리. 업계 수렴 방향과 일치
- Op ADT + `makeOp` 팩토리 — Functor Symbol, continuation 패턴 검증 완료
- 직관적 Op 이름 — `askLLM`, `executeTool` 등 설명이 필요 없는 이름
- 트레이싱 인터프리터 — 디버깅에 필수
- REPL도 Free 프로그램 — 일관된 아키텍처

**바꿀 것:**
- 고정 프로그램 체인 → **Plan-then-Execute + ReAct** (LLM이 계획/판단)
- `Act` 블랙박스 → **MCP 기반 도구 실행**
- 수동 메모리 호출 → **에이전트 루프에서 자동 관리**
- State를 독립 모나드로 → **Free Monad Op으로 통합 + 훅 시스템**
- 구현 먼저 → **조사 먼저, 설계 먼저**

### 업계 트렌드 참고 (`docs/ai-agent-trends-2025-2026.md`)

- Google 3계층: Model / Orchestration / Tools
- Andrew Ng 4패턴: Reflection, Tool Use, Planning, Multi-Agent
- 단일 에이전트 패턴: **ReAct**, **Plan-and-Execute**
- 도구 연동 표준: **MCP** (Model Context Protocol)
- 에이전트 간 통신 표준: **A2A** (Agent-to-Agent)
- 메모리: Episodic / Semantic / Procedural (칭화대 서베이)

## 아키텍처

### 핵심 파이프라인: Incremental Planning

```
User
  → loop {
      ① AskLLM: 계획 조각 생성 (JSON, rolling context 포함)
      → ② Parser + Validator: 구조 검증 → Free Monad 프로그램 변환
        → ③ Interpreter: 실행 (도구 호출, 서브 에이전트 위임 등)
          → ④ 종료 판단:
              direct_response → 사용자에게 응답 → 끝
              plan + RESPOND  → step 결과 직접 전달 → 끝
              plan - RESPOND  → 결과 관찰 → ①로 (다음 iteration)
    } maxIterations 초과 → 실패
```

**Plan-Validate-Execute-Observe-Repeat.** 한 턴의 엔진은 항상 같은 구조를 따른다.
- 전통적 plan = 초기에 여러 step을 한 번에 내는 경우
- 전통적 react = 매 iteration마다 1 step만 내는 경우
- 둘은 별도 모드가 아니라 **같은 엔진의 다른 사용 패턴**.

### 3계층 대응

```
┌──────────────────────────────────────────────────────────┐
│ Model Layer     │ LLM                                   │
│                 │   매 iteration: 계획 조각 생성         │
│                 │   최종: direct_response로 자연어 응답  │
├──────────────────────────────────────────────────────────┤
│ Orchestration   │ Free Monad                             │
│                 │   ②파서 (텍스트 → Free 프로그램)       │
│                 │   ③인터프리터 (Op 실행)                │
├──────────────────────────────────────────────────────────┤
│ Tools Layer     │ MCP 서버 / 서브 에이전트 / 메모리      │
│                 │   도구 실행, A2A 위임, 메모리 조회/저장 │
└──────────────────────────────────────────────────────────┘
```

### 예시 흐름

```
User: "오늘 PR 현황이랑 회의 안건 정리해서 팀 슬랙에 보내줘"

① AskLLM (계획 생성):
   LOOKUP_MEMORY "오늘 회의"
   EXEC github_list_prs repo="my/repo" state="open"
   EXEC jira_my_issues status="in-progress"
   ASK_LLM "PR 현황과 이슈를 종합 브리핑해줘" ctx=$1,$2,$3
   APPROVE "팀 슬랙에 브리핑 발송"
   EXEC slack_send channel="#team" message=$4

② Parser → Free Monad 프로그램 변환

③ Interpreter 실행:
   - 메모리 조회 → PR 목록 조회 → 이슈 조회
   - LLM에게 브리핑 생성 요청
   - 사용자 승인 → 슬랙 발송

④ AskLLM (결과 가공):
   "PR 3건, 이슈 2건 브리핑을 #team 채널에 발송했습니다."

→ User
```

### Free Monad이기 때문에 가능한 것

- **Dry-run**: 인터프리터만 바꾸면 실행 없이 계획 출력
- **사전 승인**: 실행 전 전체 계획을 사용자에게 보여주고 승인
- **샌드박스**: 파서가 허용된 Op만 통과 → LLM이 임의 코드 실행 불가
- **합성**: 작은 계획을 조합해서 큰 계획으로
- **재시도**: 실패 시 같은 프로그램을 다시 실행하거나, LLM에게 계획 재생성 요청

### v1과의 차이

```
v1: 입력 → LLM이 프로그램 선택 → 고정 체인 실행 → 끝
v2: 입력 → loop { LLM 계획 → validate → 실행 → 관찰 → 종료? } → 응답
```

## 반응형 State + Hook

### 설계

State 변경을 Free Monad Op으로 선언하고, 인터프리터가 공유 State 객체에 반영한 뒤
등록된 Hook을 side effect로 실행한다.

```
Free 프로그램 (순수)        인터프리터 (side effect)       Hook (반응)
───────────────────       ──────────────────────       ────────────────
updateState(path, val)  → state.set(path, val)       → hooks[path] 실행
```

### Op

```js
// State 변경 Op
const updateState = (path, value) => Free.liftF(makeOp('UpdateState')({ path, value }))
const getState    = (path)        => Free.liftF(makeOp('GetState')({ path }))
```

### 인터프리터에서의 처리

```js
case 'UpdateState':
  state.set(op.path, op.value)
  hooks.fire(op.path, op.value, state)  // 등록된 훅 실행
  return op.next(state.snapshot())

case 'GetState':
  return op.next(state.get(op.path))
```

### Hook 등록 (조립 시점)

```js
hooks.on('status', (value, state) => {
  if (value === 'working') audit.log(`턴 ${state.get('turn')} 시작`)
})

hooks.on('observations', (value, state) => {
  if (value.length >= MAX_STEPS) state.set('shouldStop', true)
})

hooks.on('memory.episodic', (value) => {
  fs.appendFileSync('episodic.jsonl', JSON.stringify(value) + '\n')
})

hooks.on('turn', (value) => {
  if (value % 10 === 0) heartbeat.send()
})
```

### 프로그램에서의 사용

```js
// 프로그램은 훅의 존재를 모른다. 상태 변경만 선언.
// 실제 에이전트 턴 코드는 "전체 턴 흐름" 섹션 참조.
updateState('status', 'working')     // → hook: 감사 로깅, 메모리 조회
updateState('turn', t => t + 1)      // → hook: heartbeat 체크
updateState('status', 'idle')        // → hook: 대화 저장
```

### 관심사 분리

| 관심사 | 위치 | 알고 있는 것 |
|--------|------|-------------|
| 상태 변경 | Free 프로그램 | "status를 working으로" — 그게 전부 |
| 실제 반영 | 인터프리터 | State 객체 mutation + Hook 호출 |
| 반응 로직 | Hook | 로깅, 영속화, 제한 검사, 알림 등 |
| 설정 | main.js 조립 | 어떤 훅을 어떤 경로에 등록할지 |

프로그램은 순수하고, 부수 효과는 전부 Hook으로 격리.
테스트 시에는 Hook 없이 실행하면 순수 State 전이만 검증 가능.

## 계획 시스템 (JSON Schema 기반)

### 왜 JSON Schema인가

텍스트 DSL은 자유도가 높지만 파싱 실패 가능성도 높다:
- LLM이 마크다운 코드블록으로 감싸거나, 설명을 덧붙이거나, 문법을 미묘하게 틀릴 수 있음
- 파서가 이 모든 변형을 방어해야 함

JSON Schema를 사용하면:
- LLM API가 스키마를 **강제** → 잘못된 구조 자체가 불가능
- `enum`으로 Op 종류를 제한 → 샌드박스 보장
- 파서가 `JSON.parse` → Op 매핑으로 단순해짐

### 응답 스키마

LLM에게 `response_format`으로 전달하는 JSON Schema:

```js
const planSchema = {
  name: 'agent_plan',
  strict: true,
  schema: {
    type: 'object',
    required: ['type'],
    properties: {
      type: {
        type: 'string',
        enum: ['plan', 'direct_response'],
        description: '계획 실행이 필요하면 plan, 단순 대화면 direct_response',
      },
      message: {
        type: 'string',
        description: 'direct_response일 때의 응답 메시지',
      },
      steps: {
        type: 'array',
        description: 'plan일 때의 실행 단계들',
        items: {
          type: 'object',
          required: ['op'],
          properties: {
            op: {
              type: 'string',
              enum: ['LOOKUP_MEMORY', 'ASK_LLM', 'EXEC', 'RESPOND', 'APPROVE', 'DELEGATE'],
            },
            args: {
              type: 'object',
              description: 'Op별 인자',
              properties: {
                query:       { type: 'string' },   // LOOKUP_MEMORY
                prompt:      { type: 'string' },   // ASK_LLM
                ctx:         { type: 'array', items: { type: 'integer' } },  // ASK_LLM 결과 참조
                tool:        { type: 'string' },   // EXEC 도구 이름
                tool_args:   { type: 'object' },   // EXEC 도구 인자
                ref:         { type: 'integer' },  // RESPOND 결과 참조
                description: { type: 'string' },   // APPROVE
                target:      { type: 'string' },   // DELEGATE 대상 에이전트
                task:        { type: 'string' },   // DELEGATE 작업 내용
              },
            },
          },
        },
      },
    },
  },
}
```

### LLM 응답 예시

```
사용자: "오늘 PR 현황이랑 이슈 정리해서 팀 슬랙에 보내줘"
```

```json
{
  "type": "plan",
  "steps": [
    { "op": "LOOKUP_MEMORY", "args": { "query": "오늘 회의" } },
    { "op": "EXEC", "args": { "tool": "github_list_prs", "tool_args": { "repo": "my/repo", "state": "open" } } },
    { "op": "EXEC", "args": { "tool": "jira_my_issues", "tool_args": { "status": "in-progress" } } },
    { "op": "ASK_LLM", "args": { "prompt": "PR 현황과 이슈를 종합하여 브리핑을 작성해줘", "ctx": [1, 2, 3] } },
    { "op": "APPROVE", "args": { "description": "팀 슬랙 #team 채널에 브리핑 발송" } },
    { "op": "EXEC", "args": { "tool": "slack_send", "tool_args": { "channel": "#team", "message": "$4" } } },
    { "op": "RESPOND", "args": { "ref": 4 } }
  ]
}
```

```
사용자: "안녕"
```

```json
{
  "type": "direct_response",
  "message": "안녕하세요! 무엇을 도와드릴까요?"
}
```

### 파서 (JSON → Free Monad)

```js
const stepToOp = (step, results) => {
  const a = step.args || {}
  switch (step.op) {
    case 'LOOKUP_MEMORY': return lookupMemory(a.query)
    case 'ASK_LLM':       return askLLM({ prompt: a.prompt, ctx: resolveRefs(a.ctx, results) })
    case 'EXEC':           return executeTool({ name: a.tool, args: a.tool_args })
    case 'RESPOND':        return respond(results[a.ref - 1])
    case 'APPROVE':        return approve(a.description)
    case 'DELEGATE':       return delegate({ target: a.target, task: a.task })
    default:               return Free.of(null)  // 알 수 없는 op → 무시 (샌드박스)
  }
}

const parsePlan = (plan) => {
  // 단순 대화
  if (plan.type === 'direct_response') {
    return respond(plan.message)
  }

  // 계획 → Free Monad 체인
  return plan.steps.reduce(
    (program, step) => program.chain(results =>
      stepToOp(step, results).chain(result =>
        Free.of([...results, result]))),
    Free.of([]))
}
```

**안전 보장:**
- JSON Schema의 `enum`이 허용된 Op만 통과시킴 (API 레벨)
- `stepToOp`의 `default`가 알 수 없는 op을 무시 (파서 레벨)
- 이중 샌드박스: LLM → JSON Schema 강제 → 파서 검증

### 계획 프롬프트 설계

**LLM이 계획을 올바르게 생성하려면, system prompt가 정확해야 한다.**

#### 프롬프트 구성 요소

```js
const buildPlannerPrompt = ({ tools, agents, memories, input }) => ({
  messages: [
    { role: 'system', content: [
      ROLE_DEFINITION,
      formatOpReference(),              // 사용 가능한 Op 설명
      formatToolList(tools),            // tools.js에서 자동 생성
      formatAgentList(agents),          // 에이전트 레지스트리에서 자동 생성
      APPROVE_RULES,
      PLAN_RULES,
      memories.length > 0
        ? `관련 기억:\n${formatMemories(memories)}`
        : '',
    ].join('\n\n') },
    { role: 'user', content: input },
  ],
  response_format: { type: 'json_schema', json_schema: planSchema },
})
```

#### 1. 역할 정의

```
당신은 업무 대리 에이전트의 계획 설계자입니다.
사용자의 요청을 분석하고, JSON 형식으로 실행 계획을 작성하세요.

- 도구 호출, 정보 조회 등이 필요하면 type: "plan"으로 steps를 작성하세요.
- 단순 대화 (인사, 간단한 질문 등)에는 type: "direct_response"로 바로 답하세요.
```

#### 2. Op 설명

```
사용 가능한 op:

LOOKUP_MEMORY: 메모리에서 관련 정보를 조회
  args: { query: "검색어" }

ASK_LLM: LLM에게 질문 (이전 단계 결과 참조 가능)
  args: { prompt: "질문", ctx: [1, 2] }
  ctx의 숫자는 이전 step의 1-based 인덱스

EXEC: 도구 실행
  args: { tool: "도구이름", tool_args: { ... } }

RESPOND: 사용자에게 응답 (이전 단계 결과 참조, 선택적 빠른 종료)
  args: { ref: 3 }
  포함 시 반드시 마지막 step. 없으면 중간 결과로 다음 iteration 진행

APPROVE: 사용자 승인 요청
  args: { description: "승인 요청 설명" }

DELEGATE: 다른 에이전트에게 위임
  args: { target: "에이전트id", task: "작업 내용" }
```

#### 3. 도구 목록 (동적 주입)

`tools.js`의 MCP 스키마에서 자동 생성. 에이전트에 마운트된 도구만 포함.

```
사용 가능한 도구:

github_list_prs: GitHub PR 목록 조회
  - repo (string, 필수): 저장소 (owner/repo)
  - state (string): open | closed | all

slack_send: 슬랙 메시지 발송
  - channel (string, 필수): 채널명
  - message (string, 필수): 메시지 내용
```

#### 4. 서브 에이전트 목록 (동적 주입)

에이전트 레지스트리에서 자동 생성. Phase 4에서 활성화.

```
위임 가능한 에이전트:

backend-team: 백엔드 팀 에이전트 (API 리뷰, 장애 분석)
```

#### 5. APPROVE 규칙

```
다음 행동 전에는 반드시 APPROVE를 넣으세요:
- 외부에 데이터를 쓰는 행동 (메시지 발송, 이슈 생성 등)
- 되돌리기 어려운 행동 (삭제, 상태 변경 등)
읽기 전용 행동에는 APPROVE가 필요 없습니다.
```

#### 6. 계획 규칙

```
규칙:
1. 충분한 정보가 있으면 direct_response를 사용. 이것이 기본 종료 방식.
2. 추가 정보가 필요하면 RESPOND 없이 plan을 반환. 실행 후 결과를 다음 iteration에서 확인 가능.
3. RESPOND는 선택적 — step 결과를 사용자에게 직접 전달하는 빠른 종료. 포함 시 마지막 step.
4. 사용 가능한 도구와 에이전트만 사용하세요.
5. ctx와 ref의 숫자는 해당 step보다 앞선 step의 인덱스(1-based)여야 합니다.
6. EXEC의 tool_args 안에서 이전 결과를 참조할 때는 "$N" 문자열을 사용합니다.
```

### 전체 턴 흐름 (Incremental Planning)

```js
const createAgentTurn = ({ tools, maxRetries, maxIterations }) => (input) =>
  beginTurn(input)
    .chain(() => getState('context.memories'))
    .chain(memories => {
      const iterate = (context, n) => {
        if (n >= maxIterations) return respondAndFail(input, ErrorInfo('Max iterations exceeded'))

        return askLLM(buildIterationPrompt(context))
          .chain(planJson => {
            const parsed = Either.pipeK(safeJsonParse, validatePlan)(planJson)
            return Either.fold(
              error => retriesLeft > 0 ? retry : respondAndFail(input, error),
              plan => {
                if (plan.type === 'direct_response')
                  return respond(plan.message).chain(msg => finishSuccess(input, msg))

                const hasRespond = plan.steps.some(s => s.op === 'RESPOND')
                return parsePlan(plan).chain(either => Either.fold(
                  err => respondAndFail(input, err),
                  results => hasRespond
                    ? finishSuccess(input, results[results.length - 1])
                    : iterate({ ...context, previousPlan: plan, previousResults: summarizeResults(results) }, n + 1),
                  either))
              }, parsed)
          })
      }
      return iterate(baseContext, 0)
    })
```

## Op 설계

### Agent Ops (8개)

```js
const FUNCTOR = Symbol.for('fun-fp-js/Functor')

const makeOp = tag => (data, next = identity) => ({
  tag, ...data, next,
  [FUNCTOR]: true,
  map: f => makeOp(tag)(data, x => f(next(x)))
})
```

| Op | 데이터 | 역할 |
|----|--------|------|
| `AskLLM` | `{ messages, tools? }` | LLM에게 질문. tools가 있으면 function calling |
| `ExecuteTool` | `{ name, args }` | MCP 도구 실행 |
| `Respond` | `{ message }` | 사용자에게 응답 |
| `Approve` | `{ description }` | 사용자 승인 요청 (Human-in-the-Loop) |
| `Delegate` | `{ target?, task }` | 다른 에이전트에게 위임 (A2A 대비) |
| `Observe` | `{ source, data }` | 도구 실행 결과를 기록 |
| `UpdateState` | `{ path, value }` | 공유 State 변경 (Hook 트리거) |
| `GetState` | `{ path }` | 공유 State 조회 |
| `Parallel` | `{ programs }` | 여러 프로그램을 병렬 실행 후 결과 합류 (Promise.all) |
| `Spawn` | `{ programs }` | 여러 프로그램을 백그라운드 실행. 결과는 State + Hook으로 비동기 수신 |

### REPL Ops (3개)

| Op | 역할 |
|----|------|
| `Read` | 사용자 입력 읽기 |
| `Write` | 콘솔 출력 |
| `Exec` | 에이전트 턴 실행 |

## 메모리

### 계층

| 계층 | 역할 | 관리 방식 |
|------|------|----------|
| **Working** | 현재 턴의 관찰들 | State의 `observations` 필드 |
| **Episodic** | 과거 대화 기록 | Hook: 턴 종료 시 자동 저장 |
| **Semantic** | 일반화된 지식/사실 | Hook: 반복 패턴 감지 시 승격 |
| **Procedural** | 학습된 도구 사용 패턴 | Phase 2 |

### Hook 기반 자동 관리

```js
// 턴 시작 → 관련 메모리 조회하여 State에 주입
hooks.on('status', async (value, state) => {
  if (value === 'working') {
    const input = state.get('currentInput')
    const memories = await memory.recall(input)
    state.set('context.memories', memories)
  }
})

// 턴 종료 → 대화 기록 저장
hooks.on('status', async (value, state) => {
  if (value === 'idle' && state.get('lastResult')) {
    await memory.save({
      input: state.get('currentInput'),
      output: state.get('lastResult'),
      observations: state.get('observations'),
    })
    state.set('observations', [])  // Working 메모리 초기화
  }
})
```

프로그램은 메모리를 직접 호출하지 않는다. Hook이 State 변경에 반응하여 자동 처리.

### Phase 1: 로컬 메모리

Neo4j 없이 시작. JSON 파일 기반.
- Episodic: `~/.presence/memory/episodic.jsonl`
- Semantic: `~/.presence/memory/semantic.json`
- 검색: 최근 N건 + 키워드 매칭 (임베딩은 Phase 2)

## 도구 시스템 (MCP)

### 도구 정의

```js
// MCP 호환 도구 스키마 → LLM function calling에 전달
const tools = [
  {
    name: 'github_list_prs',
    description: 'GitHub 저장소의 PR 목록 조회',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '저장소 (owner/repo)' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      },
      required: ['repo'],
    },
  },
]
```

### 실행 전략

```js
// Phase 1: 직접 구현 (MCP 서버 없이)
const executeToolDirect = async ({ name, args }) => {
  const handler = toolHandlers[name]
  if (!handler) throw new Error(`Unknown tool: ${name}`)
  return handler(args)
}

// Phase 3: MCP 서버 연동
const executeToolMCP = async ({ name, args }) => {
  return await mcpClient.callTool(name, args)
}
```

## 병렬 실행

### PARALLEL: 동기적 합류

모든 결과가 모일 때까지 대기. 결과를 다음 step에서 사용.

```js
// 인터프리터
case 'Parallel':
  const tasks = op.programs.map(p => Free.runWithTask(interpreter)(p))
  return Task.fromPromise(() => Promise.all(tasks))()
    .map(results => op.next(results))
```

```json
{ "op": "PARALLEL", "args": { "steps": [
  { "op": "EXEC", "args": { "tool": "github_list_prs", "tool_args": {} } },
  { "op": "EXEC", "args": { "tool": "jira_my_issues", "tool_args": {} } }
]}}
```

### SPAWN: 비동기적 반응

실행만 시키고 바로 다음 step 진행. 결과는 State + Hook으로 비동기 수신.

```js
// 인터프리터
case 'Spawn':
  op.programs.forEach((p, i) => {
    Free.runWithTask(interpreter)(p).then(result => {
      state.set(`spawned.${id}.${i}`, result)   // 완료 시 State에 publish
    })
  })
  return Task.of(op.next())  // 즉시 반환
```

### 인터프리터별 동작

| 인터프리터 | PARALLEL | SPAWN |
|-----------|----------|-------|
| **prod** | `Promise.all` (실제 병렬) | 백그라운드 실행 + State |
| **test** | 순차 실행 (결정적) | 즉시 결과 주입 |
| **traced** | 병렬 시작/합류 로깅 | spawn/완료 로깅 |

## 이벤트 소스 + Heartbeat

### 설계

에이전트 턴(사용자 요청)과 독립적으로, 외부 이벤트가 State로 흘러들어온다.
구조를 바꿀 필요 없음 — **State + Hook이 이미 이벤트 버스 역할**을 한다.

```
입력 채널 (여러 개가 동시에 동작):

  ┌─ REPL (사용자 입력)           → State → Hook → 에이전트 턴
  ├─ Webhook (GitHub, Jira 등)   → State → Hook → TODO 추가, 알림
  ├─ Heartbeat (주기적)          → State → Hook → 브리핑, 모니터링
  └─ A2A (다른 에이전트)          → State → Hook → 위임 결과 수신
```

모든 채널이 같은 State + Hook 파이프라인을 공유.
프로그램(Free Monad)은 이벤트 소스의 존재를 모른다.

### 외부 이벤트 수신

```js
// main.js 조립 시점에 이벤트 소스 연결
webhookServer.on('github.pr.assigned', (event) => {
  state.set('events.incoming', {
    type: 'pr_assigned',
    data: event,
    receivedAt: Date.now(),
  })
})

// Hook: 이벤트 → TODO 리스트에 추가
hooks.on('events.incoming', (event, state) => {
  if (event.type === 'pr_assigned') {
    const todos = state.get('todos') || []
    state.set('todos', [...todos, {
      type: 'pr_review',
      title: event.data.title,
      url: event.data.url,
      addedAt: Date.now(),
    }])
  }
})

// Hook: TODO 변경 → 사용자 알림
hooks.on('todos', (todos, state) => {
  const latest = todos[todos.length - 1]
  notify(`새 할일: [${latest.type}] ${latest.title}`)
})
```

### Heartbeat

Heartbeat는 **주기적으로 실행되는 백그라운드 에이전트 턴**.
같은 계획 시스템(JSON Schema → Free Monad)을 사용하되, 입력이 사용자가 아니라 타이머.

```js
// main.js
setInterval(async () => {
  state.set('heartbeat.trigger', Date.now())
}, HEARTBEAT_INTERVAL)

// Hook: heartbeat 트리거 → 에이전트 턴 실행
hooks.on('heartbeat.trigger', async (_, state) => {
  const plan = await generatePlan('정기 점검: PR, 이슈 현황 확인')
  const program = parsePlan(plan)
  await Free.runWithTask(interpreter)(program)
})
```

Heartbeat 결과가 메인 에이전트에게 전달되어야 할 때:
- 같은 프로세스: `state.set`으로 직접 공유
- 다른 프로세스/서버: **A2A 프로토콜**로 메시지 전달

```js
// Heartbeat가 새 PR을 발견하면 → 메인 에이전트에게 A2A로 전달
hooks.on('heartbeat.results', async (results, state) => {
  if (results.newPRs.length > 0) {
    await a2a.send({
      target: 'gunnam',            // 메인 에이전트
      type: 'notification',
      message: `새 PR ${results.newPRs.length}건 발견`,
      data: results.newPRs,
    })
  }
})
```

### 에이전트가 2개처럼 보이는 구조

```
┌──────────────────────┐     ┌──────────────────────┐
│ 메인 에이전트          │     │ Heartbeat 에이전트     │
│ (사용자 대화)          │     │ (백그라운드)           │
│                      │     │                      │
│ REPL → 계획 → 실행    │     │ Timer → 계획 → 실행   │
│         ↕            │ ←A2A→ │         ↕            │
│     State + Hook     │     │     State + Hook     │
└──────────────────────┘     └──────────────────────┘
         ↕                            ↕
    ┌─────────────────────────────────────┐
    │         공유 State (같은 프로세스)     │
    │     또는 A2A (다른 프로세스)          │
    └─────────────────────────────────────┘
```

같은 프로세스면 State 공유, 분리되면 A2A. 코드는 동일 — 인터프리터만 다름.

## 파일 구조

```
presence/
├── package.json
├── PLAN.md / CLAUDE.md
├── config.example.json
├── src/
│   ├── lib/fun-fp.js                ← fun-fp-js dist
│   ├── core/
│   │   ├── op.js                    ← Agent Op ADT + DSL (10개)
│   │   ├── plan.js                  ← Plan parser (JSON → Free) + step validation
│   │   ├── prompt.js                ← LLM 프롬프트 (iteration, retry, summarize)
│   │   ├── repl.js                  ← REPL + slash commands
│   │   └── agent.js                 ← Incremental Planning Engine + 상태 ADT
│   ├── interpreter/
│   │   ├── prod.js                  ← 프로덕션 인터프리터
│   │   ├── test.js                  ← Mock 인터프리터
│   │   ├── traced.js                ← 트레이싱 래퍼
│   │   └── dryrun.js                ← Dry-run 인터프리터
│   ├── infra/
│   │   ├── llm.js                   ← LLM 클라이언트 (timeoutMs 지원)
│   │   ├── tools.js                 ← 도구 레지스트리
│   │   ├── local-tools.js           ← 로컬 도구 6개 (file, shell, web, calc)
│   │   ├── state.js                 ← 공유 State + Hook 시스템
│   │   ├── memory.js                ← 그래프 메모리 + 벡터 검색
│   │   ├── embedding.js             ← 임베딩 (openai, cohere)
│   │   ├── persistence.js           ← 상태 영속화
│   │   ├── mcp.js                   ← MCP 클라이언트 어댑터
│   │   ├── a2a-client.js            ← A2A JSON-RPC 클라이언트
│   │   ├── agent-registry.js        ← 에이전트 레지스트리 + DelegateResult
│   │   ├── events.js                ← 이벤트 큐 + Hook 연결
│   │   ├── heartbeat.js             ← 주기적 heartbeat
│   │   ├── config.js                ← 설정 (file + env override)
│   │   ├── persona.js               ← 페르소나 설정
│   │   ├── logger.js                ← Winston 로거
│   │   └── input.js                 ← 터미널 입력 (Bracketed Paste)
│   ├── i18n/
│   │   ├── index.js                 ← i18next 초기화
│   │   ├── ko.json                  ← 한국어
│   │   └── en.json                  ← 영어
│   ├── ui/
│   │   ├── App.js                   ← Ink 최상위 앱
│   │   └── components/              ← StatusBar, ChatArea, InputBar, SidePanel 등
│   └── main.js                      ← 조립 (Config → State → Hook → Agent → REPL)
└── test/                            ← 40개 파일, 1432+ assertions
    ├── core/                        ← op, plan, prompt, agent, repl, assembly
    ├── infra/                       ← state, config, memory, mcp, events, ...
    ├── interpreter/                 ← prod, traced, dryrun
    ├── ui/                          ← app, interactive
    ├── integration/                 ← phase5 E2E
    ├── regression/                  ← llm-output, tool-defense, plan-fuzz, e2e-scenario
    ├── manual/                      ← live-llm (실제 LLM 테스트)
    └── run.js
```

## 구현 순서

각 Step은 **조사 → 설계 → 구현 → 테스트** 순서.

### Phase 1~5: ✅ 완료

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
- 1578 assertions, 40 test files

### Phase 6: 터미널 UI (Ink) — ✅ 완료

| Step | 파일 | 내용 |
|------|------|------|
| **31** | `src/ui/hooks/useAgentState.js` | State → UI 바인딩 React Hook |
| **32** | `src/ui/components/StatusBar.js` | 상단 status bar 개선 (iteration, retry 표시) |
| **33** | `src/ui/components/PlanView.js` | iteration/step 인라인 시각화 (핵심 신규) |
| **34** | `src/ui/components/ChatArea.js` | 대화 영역 개선 (PlanView 인라인 통합) |
| **35** | `src/ui/components/InputBar.js` | 입력 바 개선 |
| **36** | `src/ui/components/SidePanel.js` | 컨텍스트 패널 (agents, tools, memory, todos, events) |
| **37** | `src/ui/components/ApprovePrompt.js` | APPROVE 인라인 프롬프트 |
| **38** | `src/ui/App.js` | 레이아웃 매니저 + 사이드 패널 토글 |
| **39** | `src/main.js` | readline → Ink 앱 전환, Hook → UI 연결 |

**Phase 6 이후 추가 구현:**
- Prompt Assembly + Budget fitting (단계적 fitting: system → history → memories)
- Conversation History (rolling window max 20턴, source filtering, truncation)
- Iteration context compaction (이전 plan/results 요약하여 rolling context)
- TranscriptOverlay 디버그 (assembly metadata: budget/used/dropped)
- Config: prompt budget 설정 (`prompt.maxContextChars`, `prompt.reservedOutputChars`)
- config.js: `Either.catch()` 패턴 적용 (agent.js `safeJsonParse`와 일관성)
- 코드 품질 리팩터링: 정책 상수 통합(`src/core/policies.js`), MemoryGraph encapsulation(`removeNodes`), 에러 경계 정리(`persistence.js` try-catch, `memory-maintenance.js` 무음 삼킴 수정)
- 1578 assertions, 40 test files

### Phase 7: 웹 UI (React + Vite)

| Step | 내용 | 선행 조사 |
|------|------|----------|
| **40** | API 서버 (Express/Fastify + WebSocket) | — |
| **41** | WebSocket Hook 연결 (State → 브라우저 실시간 push) | — |
| **42** | 웹 프론트엔드 (React + Vite, 터미널 UI 컴포넌트 재활용) | — |

### Phase 8: 계층적 에이전트

| Step | 내용 | 선행 조사 |
|------|------|----------|
| **43** | 계층적 에이전트 (Supervisor 패턴) | Google ADK 아키텍처 조사 |

### TODO

- **2-Track 비동기 큐**: 현재 Hook의 비동기 작업(메모리 저장, 임베딩, 히스토리 압축)이 fire-and-forget으로 순서 보장 없음. 모든 비동기 처리를 큐 기반으로 통합하되, 크리티컬 경로(recall → 프롬프트 → LLM → 실행)와 백그라운드(임베딩, 압축)를 분리하는 2-track 큐 구조 도입. 느린 백그라운드 작업이 다음 턴을 차단하지 않으면서도, 크리티컬 경로 내 순서는 보장.

- **StateT 기반 인터프리터 리팩토링**: 현재 인터프리터가 `state.set()`을 명령형으로 호출하여 상태를 변경함. 상태 관리를 순수 전이로 전환하고, `UpdateState`/`GetState` Op을 제거. Hook 발동은 전이 결과에서 이전/새 상태를 비교하여 처리. → Effect-TS 도입 시 `Ref`로 해결.

- **레이어 의존성 정리**: `core/prompt.js`가 `infra/tokenizer.js`를 import하여 core → infra 의존성 역전 발생. 원칙은 infra → core 단방향. tokenizer를 core로 이동하거나, prompt.js에 토큰 측정 함수를 주입하는 구조로 변경. 다른 레이어 경계 위반도 함께 점검.

- **인터프리터 합성 구조**: 현재 `prod.js`가 모든 Op 핸들러(LLM, 도구, 상태, 위임, 승인)를 단일 dispatch 객체로 관리. 관심사별 인터프리터를 분리하고 합성하는 미들웨어 패턴 도입. 개별 인터프리터의 독립 테스트가 가능해지고, StateT 전환 시 상태 관련 핸들러만 교체 가능. 예: `composInterpreters(llmInterpreter, toolInterpreter, stateInterpreter, delegateInterpreter)`.

- **Plan 정규화 파이프라인**: 현재 `normalizeStep`이 EXEC→DELEGATE 한 패턴만 ad-hoc으로 처리. 로컬 LLM의 혼동 패턴은 계속 증가할 것. validation 전에 정규화 파이프라인을 두고, rewrite 규칙을 선언적으로 등록/관리하는 구조 도입. 예: `[normalizeDelegate, normalizeApprove, ...]` 규칙 배열을 순차 적용.

- **메모리 임베딩 관심사 분리**: `MemoryGraph.embedPending(embedder)`가 저장소 클래스 안에서 임베딩까지 수행. 저장과 벡터화는 다른 관심사. `MemoryEmbedder` 서비스로 분리하여 MemoryGraph는 노드/엣지 CRUD + 검색만 담당, 임베딩은 외부에서 수행 후 벡터를 돌려주는 구조로 변경.

- **메모리 검색 인덱스**: 현재 키워드/벡터 검색이 전부 `nodes.filter()` 선형 스캔. 단계적 개선: (1) 키워드 역인덱스(term → nodeId set) 추가로 키워드 검색 O(1) 근접화 — 외부 의존 없이 즉시 가능. (2) 노드 수천 건 이상 시 SQLite + vector extension으로 저장소 전략 교체. (3) 멀티 인스턴스/서버 환경(Phase 7 이후) 시 전용 벡터 DB 검토.

- **메모리 무효화**: 사실 기반 메모리가 오래되면 LLM을 오도함. 현재는 시간 기반 수동 삭제만 가능. 단계적 해결: (1) 노드에 `expiresAt` 필드 추가 + recall 시 필터 — 즉시 적용 가능, 외부 의존 없음. (2) 출처 연결(도구명 + 인자 기록) — 같은 도구+인자로 새 결과가 들어오면 이전 메모리 자동 갱신, 구조적으로 가장 견고. (3) 저장소가 SQLite/Redis로 전환되면 TTL을 미들웨어에 위임.

- **프로퍼티 기반 테스트**: 현재 테스트는 구체적 케이스만 검증. FP 타입(Free, Either, Maybe, Task)의 모나드/펑터 법칙 성립을 랜덤 입력으로 검증하면 구조적 정합성을 수학적으로 확인 가능. fun-fp-js 타입과 agent 상태 전이 모두 대상. 라이브러리: [fast-check](https://github.com/dubzzz/fast-check).

- **경계 스키마 검증 (Zod 활용)**: Zod가 의존성에 있으나 거의 미사용. config 로딩, 도구 인자, LLM 응답 파싱, 메모리 노드 등 시스템 경계마다 Zod 스키마 검증 도입. 수작업 `typeof` 체크를 선언적 스키마로 교체하여 잘못된 데이터가 내부로 유입되는 것을 구조적으로 차단.

- **프롬프트를 데이터로**: 현재 프롬프트가 문자열 하드코딩. 구조화된 데이터(AST)로 표현하면 합성, 예산 계산, 버전 관리, 직렬화, 테스트 가능한 변경 관리가 자연스러워짐. 프롬프트 변경의 영향을 회귀 테스트로 검증 가능.

- **SQLite 기반 메모리 저장소**: lowdb(JSON 파일) → SQLite 전환으로 검색 인덱스, TTL, 트랜잭션, 벡터 검색을 단일 저장소에서 해결. 서버 프로세스 없이 단일 파일 — `npm start`만으로 실행 원칙 유지. 라이브러리: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) + [sqlite-vec](https://github.com/asg017/sqlite-vec) (벡터 검색 확장).

- **실행 인프라 방향 (미결정, 두 경로 검토 중)**:
  - **경로 A — fun-fp-js 자체 확장**: fun-fp-js에 StateT(M), Fiber(fork/cancel/join), 스케줄러, 구조적 동시성을 직접 구현. JavaScript 유지. Effect-TS는 설계 레퍼런스로 참고. presence가 fun-fp-js의 실전 검증 무대가 되고, 프로젝트에 필요한 만큼만 구현하여 무게 조절 가능. 라이브러리에 대한 완전한 이해와 소유권 확보.
  - **경로 B — Effect-TS 도입 + TypeScript 전환**: Effect-TS를 실행 인프라로 도입하고, 그 위에 Free Monad 구현(`runWithEffect`). Either→`Either`, Maybe→`Option`, Task→`Effect` 전환. fun-fp-js 제거. StateT, 큐, 인터프리터 합성, 에러 통일, DI, 스키마 검증 등 다수 TODO가 해결됨. 단, TypeScript 전환 필요, Effect-TS 프레임워크 종속.
  - **공통**: 어느 경로든 Free Monad은 프로그램 표현 계층으로 유지. AST 검사/변환(dry-run, traced, test)은 보존.

## 운영 결정

| 결정 | 내용 | 이유 |
|------|------|------|
| history source 필터링 | `conversationHistory`는 `source === 'user'` 성공 턴만 저장 | heartbeat/event 턴이 대화 맥락을 오염시키지 않도록 |
| prompt assembly budget | budget 기반 단계적 fitting (system → history → memories) | 고정 크기 컨텍스트 안에서 최신 대화를 우선 보존 |
| embedder null 처리 | embedder 없으면 memory recall 빈 배열 반환 | 키워드 단독 검색은 noise가 많아 오히려 해로움 |
| history rolling window | 상한 20턴 + budget fitting으로 추가 축소 | LLM 컨텍스트 효율성, 오래된 대화는 가치 감소 |
| tools/agents compaction | name-only compaction은 v1 범위 밖, v2에서 추가 | 안정화 단계에서 불필요한 변경 회피 |

### FP 라이브러리 활용 판단

| 항목 | 판단 | 이유 |
|------|------|------|
| `Either.catch()` (config.js) | **적용** | agent.js `safeJsonParse`와 일관된 패턴 |
| prompt.js `pipe()` | 보류 | 안정화 단계에서 불필요한 변경 |
| state.js `Maybe` 체인 | 유지 | hot path, 성능 우선 |
| `Writer` monad (tracing) | 보류 | fun-fp-js WriterT 필요 |
| `Reader` monad (DI) | 유지 | 현재 클로저 기반이 더 직관적 |
| `Validation` monad | 유지 | short-circuit이 현재 검증에 적합 |
| `curry`/`compose` | 유지 | point-free 스타일은 프로젝트 성격 불일치 |

## 검증 방법

```bash
# 전체 테스트 (mock 기반, LLM 불필요)
node test/run.js                    # 1578 assertions

# 실제 LLM 테스트
node test/manual/live-llm.test.js   # 로컬 MLX 서버 필요

# 앱 실행
node src/main.js
```

## 핵심 제약

- **조사 먼저**: "선행 조사" 칼럼이 비어있지 않으면, 구현 전에 해당 스펙/논문을 확인
- **Op 이름은 직관적으로**: `askLLM`, `executeTool`, `updateState` — 설명 불필요
- **Free Monad는 인프라**: 프로그램 형태는 바뀔 수 있지만 Free + Interpreter는 유지
- **State 변경은 Op으로**: 명령형 mutation 금지. 프로그램에서 선언, 인터프리터에서 반영
- **부수 효과는 Hook으로**: 로깅, 영속화, 알림 등은 프로그램이 아닌 Hook에서 처리
- **Phase 1에서 외부 의존성 없이 검증**: mock으로 전체 흐름을 먼저 증명

## fun-fp-js API 참고

```javascript
import fp from '../lib/fun-fp.js'
const { Free, State, Task, identity } = fp

// Free
Free.of(x)              // Pure(x)
Free.liftF(functor)     // functor를 Free로 리프트 (Functor Symbol 필수)
Free.runWithTask(runner) // (functor => Task) => Free => Promise

// Task
Task.of(x)              // resolve(x)
Task.rejected(x)        // reject(x)
Task.fromPromise(fn)    // (() => Promise) => () => Task

// makeOp (AgentOp 팩토리)
// map은 data가 아닌 continuation(next)에 적용해야 함
const makeOp = tag => (data, next = identity) => ({
  tag, ...data, next,
  [FUNCTOR]: true,
  map: f => makeOp(tag)(data, x => f(next(x)))
})
```
