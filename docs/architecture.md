# Presence — 아키텍처 설계 문서

> 이 문서는 Phase 1-8에서 확정된 핵심 설계를 기록합니다. 실제 구현은 코드를 참조하세요.
> Phase 7(서버-클라이언트 분리 + 세션 관리)과 Phase 8(Supervisor 패턴)은 `PLAN.md` 참조.

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

## 핵심 파이프라인: Incremental Planning

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

### Free Monad이기 때문에 가능한 것

- **Dry-run**: 인터프리터만 바꾸면 실행 없이 계획 출력
- **사전 승인**: 실행 전 전체 계획을 사용자에게 보여주고 승인
- **샌드박스**: 파서가 허용된 Op만 통과 → LLM이 임의 코드 실행 불가
- **합성**: 작은 계획을 조합해서 큰 계획으로
- **재시도**: 실패 시 같은 프로그램을 다시 실행하거나, LLM에게 계획 재생성 요청

## 반응형 State + Hook

State 변경을 Free Monad Op으로 선언하고, 인터프리터가 공유 State 객체에 반영한 뒤
등록된 Hook을 side effect로 실행한다.

```
Free 프로그램 (순수)        인터프리터 (side effect)       Hook (반응)
───────────────────       ──────────────────────       ────────────────
updateState(path, val)  → state.set(path, val)       → hooks[path] 실행
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

- LLM API가 스키마를 **강제** → 잘못된 구조 자체가 불가능
- `enum`으로 Op 종류를 제한 → 샌드박스 보장
- 파서가 `JSON.parse` → Op 매핑으로 단순해짐

### 응답 스키마

```js
const planSchema = {
  name: 'agent_plan',
  strict: true,
  schema: {
    type: 'object',
    required: ['type'],
    properties: {
      type: { type: 'string', enum: ['plan', 'direct_response'] },
      message: { type: 'string' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          required: ['op'],
          properties: {
            op: { type: 'string', enum: ['LOOKUP_MEMORY', 'ASK_LLM', 'EXEC', 'RESPOND', 'APPROVE', 'DELEGATE'] },
            args: { type: 'object' },
          },
        },
      },
    },
  },
}
```

### 안전 보장

- JSON Schema의 `enum`이 허용된 Op만 통과시킴 (API 레벨)
- `stepToOp`의 `default`가 알 수 없는 op을 무시 (파서 레벨)
- 이중 샌드박스: LLM → JSON Schema 강제 → 파서 검증

## Op 설계

### Agent Ops

```js
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
| `Parallel` | `{ programs }` | 여러 프로그램을 병렬 실행 후 결과 합류 |
| `Spawn` | `{ programs }` | 여러 프로그램을 백그라운드 실행 |

### REPL Ops

| Op | 역할 |
|----|------|
| `Read` | 사용자 입력 읽기 |
| `Write` | 콘솔 출력 |
| `Exec` | 에이전트 턴 실행 |

## 메모리

| 계층 | 역할 | 관리 방식 |
|------|------|----------|
| **Working** | 현재 턴의 관찰들 | State의 `observations` 필드 |
| **Episodic** | 과거 대화 기록 | Hook: 턴 종료 시 자동 저장 |
| **Semantic** | 일반화된 지식/사실 | Hook: 반복 패턴 감지 시 승격 |
| **Procedural** | 학습된 도구 사용 패턴 | Phase 2 |

프로그램은 메모리를 직접 호출하지 않는다. Hook이 State 변경에 반응하여 자동 처리.

## 도구 시스템 (MCP)

MCP 호환 도구 스키마 → LLM function calling에 전달. Phase 1은 직접 구현, Phase 3에서 MCP 서버 연동.

## 병렬 실행

| 인터프리터 | PARALLEL | SPAWN |
|-----------|----------|-------|
| **prod** | `Promise.all` (실제 병렬) | 백그라운드 실행 + State |
| **test** | 순차 실행 (결정적) | 즉시 결과 주입 |
| **traced** | 병렬 시작/합류 로깅 | spawn/완료 로깅 |

## 이벤트 소스 + Heartbeat

에이전트 턴(사용자 요청)과 독립적으로, 외부 이벤트가 State로 흘러들어온다.
State + Hook이 이미 이벤트 버스 역할을 한다.

```
입력 채널 (여러 개가 동시에 동작):

  ┌─ REPL (사용자 입력)           → State → Hook → 에이전트 턴
  ├─ Webhook (GitHub, Jira 등)   → State → Hook → TODO 추가, 알림
  ├─ Heartbeat (주기적)          → State → Hook → 브리핑, 모니터링
  └─ A2A (다른 에이전트)          → State → Hook → 위임 결과 수신
```

Heartbeat는 주기적으로 실행되는 백그라운드 에이전트 턴. 같은 계획 시스템을 사용하되, 입력이 사용자가 아니라 타이머.

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
