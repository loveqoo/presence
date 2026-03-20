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

### 핵심 파이프라인

```
User
  → ① AskLLM: 계획 생성 (string)
    → ② Parser: Free Monad 프로그램으로 변환
      → ③ Interpreter: 실행 (도구 호출, 서브 에이전트 위임 등)
        → ④ AskLLM: 실행 결과를 사람 말로 가공
          → User
```

**LLM은 두 번 호출된다:**
1. **입구** — 뭘 할지 계획 (텍스트 DSL 생성)
2. **출구** — 실행 결과를 사용자에게 전달할 형태로 가공

**그 사이는 기계적 실행.** LLM의 판단 없이 Free Monad 프로그램이 돌아간다.

### 3계층 대응

```
┌──────────────────────────────────────────────────────────┐
│ Model Layer     │ LLM                                   │
│                 │   ①계획 생성 (system prompt + DSL)     │
│                 │   ④결과 가공 (실행 결과 → 자연어)      │
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
v2: 입력 → LLM이 계획 작성(string) → 파서(Free) → 실행 → LLM이 결과 가공 → 응답
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

RESPOND: 사용자에게 응답 (이전 단계 결과 참조)
  args: { ref: 3 }
  반드시 계획의 마지막에 포함

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
1. plan의 마지막 step은 반드시 RESPOND여야 합니다.
2. 사용 가능한 도구와 에이전트만 사용하세요.
3. ctx와 ref의 숫자는 해당 step보다 앞선 step의 인덱스(1-based)여야 합니다.
4. EXEC의 tool_args 안에서 이전 결과를 참조할 때는 "$N" 문자열을 사용합니다.
```

### 전체 턴 흐름

```js
const agentTurn = (input) =>
  updateState('status', 'working')
    .chain(() => updateState('currentInput', input))
    // ① LLM에게 계획 생성 요청 (JSON Schema 강제)
    .chain(() => getState('context.memories'))
    .chain(memories => askLLM(buildPlannerPrompt({ tools, agents, memories, input })))
    // ② JSON 파싱 → Free Monad 프로그램
    .chain(planJson => {
      const plan = JSON.parse(planJson)
      return parsePlan(plan)
    })
    // ③ 실행 결과를 LLM에게 전달하여 가공
    .chain(results => askLLM(buildFormatterPrompt(input, results)))
    .chain(response => respond(response))
    .chain(response =>
      updateState('lastResult', response)
        .chain(() => updateState('status', 'idle'))
        .chain(() => Free.of(response)))
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
├── PLAN.md
├── CLAUDE.md
├── config.example.js
├── docs/
│   └── ai-agent-trends-2025-2026.md
├── src/
│   ├── lib/fun-fp.js                ← fun-fp-js dist
│   ├── core/
│   │   ├── op.js                    ← Agent Op ADT + DSL (8개)
│   │   ├── plan.js                  ← 계획 DSL 파서 (텍스트 → Free)
│   │   ├── react.js                 ← ReAct 루프 (Free 프로그램)
│   │   ├── repl.js                  ← REPL (Free 프로그램)
│   │   └── agent.js                 ← 에이전트 턴 관리
│   ├── interpreter/
│   │   ├── prod.js                  ← 프로덕션 인터프리터 (State + Hook 처리)
│   │   ├── test.js                  ← Mock 인터프리터
│   │   ├── traced.js                ← 트레이싱 래퍼
│   │   └── dryrun.js                ← Dry-run 인터프리터 (계획 검증용)
│   ├── infra/
│   │   ├── llm.js                   ← LLM 클라이언트 (function calling)
│   │   ├── tools.js                 ← 도구 레지스트리 + MCP 스키마
│   │   ├── state.js                 ← 공유 State 객체 + Hook 시스템
│   │   ├── memory.js                ← 메모리 관리 (Hook에서 호출)
│   │   └── input.js                 ← 터미널 입력 (Bracketed Paste)
│   └── main.js                      ← 조립 (State 생성, Hook 등록, 인터프리터 구성)
└── test/
    ├── core/
    │   ├── op.test.js
    │   ├── plan.test.js             ← 계획 파서 테스트
    │   ├── react.test.js            ← ReAct 루프 테스트
    │   └── agent.test.js
    ├── infra/
    │   └── state.test.js            ← State + Hook 테스트
    └── run.js
```

## 구현 순서

각 Step은 **조사 → 설계 → 구현 → 테스트** 순서.

### Phase 1: 코어 (외부 의존성 없이 검증)

| Step | 파일 | 내용 | 선행 조사 |
|------|------|------|----------|
| **1** | `package.json`, `src/lib/fun-fp.js` | 프로젝트 초기화 | — |
| **2** | `src/core/op.js` | Op ADT 8개 + DSL | v1 코드 재활용 |
| **3** | `src/infra/state.js` | 공유 State 객체 + Hook 시스템 | — |
| **4** | `test/infra/state.test.js` | State + Hook 테스트 | — |
| **5** | `src/interpreter/test.js` | Mock 인터프리터 (State+Hook 포함) | — |
| **6** | `src/infra/tools.js` | 도구 레지스트리 + MCP 스키마 | MCP 스펙 조사 |
| **7** | `src/core/plan.js` | 계획 DSL 파서 (텍스트 → Free) | — |
| **8** | `test/core/plan.test.js` | 파서 테스트 (텍스트 → Free → mock 실행) | — |
| **9** | `src/core/react.js` | ReAct 루프 (Free 프로그램) | ReAct 논문, function calling 스펙 |
| **10** | `test/core/react.test.js` | ReAct 테스트 (mock 도구) | — |
| **11** | `src/core/agent.js` | 에이전트 턴 (State + Plan/ReAct 통합) | — |
| **12** | `test/core/agent.test.js` | 에이전트 턴 테스트 | — |

### Phase 2: 실제 연동

| Step | 파일 | 내용 | 선행 조사 |
|------|------|------|----------|
| **13** | `src/infra/llm.js` | LLM 클라이언트 (function calling) | OpenAI function calling 스펙 |
| **14** | `src/interpreter/prod.js` | 프로덕션 인터프리터 | — |
| **15** | `src/interpreter/traced.js` | 트레이싱 래퍼 | v1 코드 재활용 |
| **16** | `src/interpreter/dryrun.js` | Dry-run 인터프리터 | — |
| **17** | `src/infra/input.js` | 터미널 입력 | Bracketed Paste Mode 스펙 조사 |
| **18** | `src/infra/memory.js` | 로컬 메모리 (Hook에서 호출) | — |
| **19** | `src/core/repl.js` + `src/main.js` | REPL + 조립 + Hook 등록 | v1 코드 재활용 |

### Phase 3: MCP + 도구 확장

| Step | 내용 | 선행 조사 |
|------|------|----------|
| **20** | MCP 클라이언트 구현 | MCP JS SDK 조사 |
| **21** | GitHub 도구 연동 | GitHub MCP 서버 조사 |
| **22** | 메모리 영속화 (파일 기반) | — |
| **23** | 임베딩 기반 메모리 검색 | 사용 가능한 임베딩 모델 조사 |

### Phase 4: Heartbeat + 이벤트 소스

| Step | 내용 | 선행 조사 |
|------|------|----------|
| **24** | 이벤트 수신 인프라 (webhook 서버 또는 polling) | — |
| **25** | Heartbeat 에이전트 (주기적 계획 실행) | — |
| **26** | TODO 관리 (이벤트 → State → Hook → 목록 관리) | — |

### Phase 5: Multi-Agent + A2A

| Step | 내용 | 선행 조사 |
|------|------|----------|
| **27** | Delegate op 구현 | A2A 프로토콜 스펙 조사 |
| **28** | 에이전트 레지스트리 | — |
| **29** | Heartbeat ↔ 메인 에이전트 A2A 통신 | — |
| **30** | 계층적 에이전트 (Supervisor 패턴) | Google ADK 아키텍처 조사 |

## 검증 방법

```bash
# Phase 1: 코어 테스트 (LLM 없이)
node test/infra/state.test.js    # State + Hook
node test/core/op.test.js        # Op ADT
node test/core/plan.test.js      # 계획 파서
node test/core/react.test.js     # ReAct 루프
node test/core/agent.test.js     # 에이전트 턴
node test/run.js                 # 전체

# Phase 2: 실제 LLM 연동
node src/main.js
```

**Phase 1 (Step 1~12)은 외부 의존성 없이 테스트 가능.**

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
