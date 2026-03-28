# Phase D: Hook → Actor 통합

## Context

현재 비동기 조율이 두 가지 패턴으로 나뉘어 있음:
- **Actor**: MemoryActor, CompactionActor, PersistenceActor, TurnActor — 큐 기반 직렬화
- **Hook**: wireEventHooks, wireTodoHooks, wireBudgetWarning, wireDelegatePolling — 상태 변경 반응

같은 레벨의 관심사(비동기 비즈니스 로직)가 서로 다른 추상화를 사용. Hook에 비즈니스 로직이 들어 있어 테스트가 상태 조작에 의존하고, 동시성 보호가 `processing` 플래그 같은 수동 장치에 의존.

**목표**: 모든 비동기 비즈니스 로직을 Actor로 통합. Hook은 "상태 변경 → Actor 메시지" 브릿지로만 남김.

## 설계

### Before → After 구조

```
Before:
  state.set('events.queue') → hook(wireEventHooks) → 비즈니스 로직 → turnActor.send
  state.set('_debug.lastTurn') → hook(wireBudgetWarning) → 비즈니스 로직
  turnState=idle → hook(wireDelegatePolling) → HTTP 폴링 → emit()

After:
  eventActor.send('enqueue') → EventActor(비즈니스 로직) → turnActor.send
  budgetActor.send('check') → BudgetActor(비즈니스 로직)
  delegateActor.send('poll') → DelegateActor(비즈니스 로직) → eventActor.send

  남은 Hook (브릿지만):
    turnState=idle → eventActor.drain + delegateActor.poll
    _debug.lastTurn → budgetActor.check
```

### 새 Actor 3개

#### EventActor (wireEventHooks + wireTodoHooks + createEventReceiver 흡수)

```js
createEventActor({ turnActor, state, logger })
```

| 메시지 | 동작 |
|--------|------|
| `enqueue(event)` | Actor 내부 큐에 추가 → ReactiveState에 projection → idle이면 자체 `drain` 전송 |
| `drain` | **idempotent**: 큐 비었거나 inFlight이면 no-op. idle 확인 → dequeue → turnActor.send → 성공 시 TODO 생성 → 큐 남아있으면 자체 `drain` 전송 |

**상태 원천 규칙:**
- **Source of truth**: Actor 내부 상태 (`init: { queue: [], inFlight: null }`)
- **ReactiveState.events.\***: projection/cache (UI 관찰 전용)
- **외부 로직은 ReactiveState.events.\*를 절대 직접 수정하지 않음**
- **Projection 타이밍**: 각 상태 전이 직후 즉시 projection 갱신 (enqueue/dequeue/inFlight/deadLetter 변경마다)

**deadLetter shape:**
```js
{ ...event, error: string, failedAt: number }
```

**drain idempotency 규칙:**
- `queue.length === 0` → no-op
- `inFlight !== null` → no-op (이미 처리 중)
- `turnState !== idle` → no-op (턴 진행 중)
- 위 조건 모두 통과해야 실제 dequeue + turnActor.send

**재진입 흐름 (의도됨):**
```
eventActor.drain → turnActor.send → agent.run → turnState=idle
  → 브릿지 hook → eventActor.drain (Actor 큐 직렬화로 안전)
  → drain: 큐 비었으면 no-op, 남았으면 다음 이벤트 처리
```

- Actor 큐가 `processing` 플래그를 대체 (직렬화 보장)
- TODO 로직 인라인 (`applyTodo` 순수 함수)

**emit() 대체 (fire-and-forget wrapper):**
```js
// createEmit: fire-and-forget. enriched event를 동기 반환.
// enqueue 실패를 관찰하지 않음 — Actor 큐 push만 하고 결과 무시.
const createEmit = (eventActor) => (event) => {
  const enriched = withEventMeta(event)
  eventActor.send({ type: 'enqueue', event: enriched }).fork(() => {}, () => {})
  return enriched
}
```

#### BudgetActor (wireBudgetWarning 흡수)

```js
createBudgetActor({ state })
```

| 메시지 | 동작 |
|--------|------|
| `check({ debug, turn })` | budget 분석 → 임계치 초과 시 `_budgetWarning` 설정 |

- `lastWarnedTurn`을 Actor 내부 상태로 관리 (관용적)
- Actor.init: `{ lastWarnedTurn: -1 }`
- 가장 얇은 Actor. "모든 비동기 비즈니스 로직 Actor화" 원칙을 위해 존재.
- **no-op 조건**: `!debug?.assembly` 또는 `budget === Infinity` 또는 `turn === lastWarnedTurn` → 즉시 반환

#### DelegateActor (wireDelegatePolling 흡수)

```js
createDelegateActor({ state, eventActor, agentRegistry, logger, pollIntervalMs })
```

| 메시지 | 동작 |
|--------|------|
| `poll` | **polling=false일 때만 실행**. idle 확인 → delegates.pending 폴링 → 결과를 eventActor.enqueue. **타이머를 절대 건드리지 않음.** |
| `start` | `running=true` → 최초 `tick` 예약 |
| `stop` | `running=false` → 타이머 정리 |
| `tick` | **running=true일 때만 실행**. 다음 타이머 예약 + poll 호출. polling 중이면 poll이 자체 no-op |

**중복 방지 규칙:**
- Actor 내부 상태: `{ running: false, polling: false }`
- `tick`: `running=false`면 no-op (stop 이후 남은 tick 방어)
- `poll`: `polling=true`면 no-op (이전 poll 진행 중)
- `poll` 시작 시 `polling=true`, 완료/실패 시 `polling=false`
- **타이머 책임 분리**: tick만 타이머를 scheduling. poll은 절대 타이머를 건드리지 않음

- PersistenceActor와 동일한 self-send 타이머 패턴
- `getA2ATaskStatus` 등 순수 함수는 `a2a-client.js`에 유지

### 남는 Hook (비즈니스 로직 없음, 브릿지만)

```js
// main.js — 총 3개 hook, 각각 1줄 로직
state.hooks.on('turnState', (phase) => {
  if (phase.tag === 'idle') {
    eventActor.send({ type: 'drain' }).fork(() => {}, () => {})
    delegateActor.send({ type: 'poll' }).fork(() => {}, () => {})
  }
  if (phase.tag === PHASE.WORKING) {
    trace.length = 0; state.set('_debug.opTrace', [])
  }
})
state.hooks.on('_debug.lastTurn', (debug, s) => {
  budgetActor.send({ type: 'check', debug, turn: s.get('turn') }).fork(() => {}, () => {})
})
```

### Heartbeat 변경

```js
// Before: createHeartbeat({ emit, state, ... })
// After:  createHeartbeat({ eventActor, state, ... })
// emit 대신 eventActor.send({ type: 'enqueue', event: ... })
// 백프레셔: eventActor.getState()로 큐/inFlight 확인
```

### main.js 조립 결과

```js
// === Actors (모두 한 곳) ===
const memoryActor = createMemoryActor({ graph: memory, embedder, logger })
const compactionActor = createCompactionActor({ llm, logger })
const persistenceActor = createPersistenceActor({ store: persistence.store })
const turnActor = createTurnActor((input, opts) => agent.run(input, opts))
const eventActor = createEventActor({ turnActor, state, logger })
const budgetActor = createBudgetActor({ state })
const delegateActor = createDelegateActor({
  state, eventActor, agentRegistry, logger,
  pollIntervalMs: config.delegatePolling.intervalMs,
})

// === emit (EventActor 경유) ===
const emit = createEmit(eventActor)

// === 브릿지 Hook (로직 없음) ===
state.hooks.on('turnState', (phase) => { ... })     // idle→drain+poll, working→opTrace
state.hooks.on('_debug.lastTurn', (debug, s) => { ... }) // →budgetActor.check

// === Heartbeat (eventActor 직접) ===
const heartbeat = createHeartbeat({ eventActor, state, ... })
```

## 영향 받는 파일

| 파일 | 변경 |
|------|------|
| `src/infra/actors.js` | EventActor, BudgetActor, DelegateActor, applyTodo, createEmit 추가 |
| `src/infra/events.js` | wireEventHooks, wireTodoHooks 제거. 순수 함수(withEventMeta, eventToPrompt, todoFromEvent, isDuplicate) 유지 |
| `src/infra/budget-warning.js` | wireBudgetWarning 제거 (파일 삭제 또는 빈 파일) |
| `src/infra/a2a-client.js` | wireDelegatePolling 제거. pollPendingDelegates 추출 export. 순수 함수 유지 |
| `src/infra/heartbeat.js` | emit → eventActor 파라미터 변경. 백프레셔 체크 Actor 기반으로 |
| `src/main.js` | wire* 호출 → Actor 생성 + 브릿지 Hook으로 교체 |
| `test/infra/events.test.js` | Hook 테스트 → EventActor 메시지 기반 테스트로 재작성 |
| `test/core/turn-concurrency.test.js` | C6: wireEventHooks → EventActor + 브릿지 Hook |
| `test/e2e/bootstrap.test.js` | main.js 조립 변경에 따라 검증 |

## 실행 순서

### Step 1: actors.js에 새 Actor 추가

EventActor, BudgetActor, DelegateActor + 헬퍼(applyTodo, createEmit) 추가. 기존 Actor 변경 없음.

### Step 2: events.js 정리

wireEventHooks, wireTodoHooks 제거. createEventReceiver는 deprecation 주석 후 유지 (테스트 호환).

### Step 3: budget-warning.js, a2a-client.js 정리

wireBudgetWarning 제거. wireDelegatePolling 제거, pollPendingDelegates export.

### Step 4: heartbeat.js 업데이트

emit → eventActor 파라미터. 백프레셔 체크 변경.

### Step 5: main.js 재조립

wire* 호출 제거 → Actor 생성 + 브릿지 Hook.

### Step 6: 테스트 업데이트

events.test.js 재작성. turn-concurrency.test.js C6 수정. bootstrap.test.js 확인.

### Step 7: 전체 테스트 실행 및 검증

`node test/run.js` — 전체 통과 확인.

## 검증

1. `node test/run.js` — 전체 테스트 통과
2. **Actor 패턴 일관성**: main.js에서 모든 비동기 로직이 Actor.send()로 시작
3. **남은 Hook 기준**: "hook에 business logic이 있는가?" — 없어야 함
4. **EventActor 테스트**: "enqueue 3개 + drain 1개 → 순차 처리" 케이스 포함
5. **EventActor drain idempotency**: 큐 비었을 때, inFlight일 때, not-idle일 때 no-op 확인
6. **DelegateActor 테스트**: "tick 중복에도 poll 1회만" 케이스 포함
7. **실패 시나리오**: turnActor 실패 → deadLetter 처리 확인
8. **동시성**: enqueue 중 drain 진행 → Actor 큐 직렬화 확인

## 범위 제한

- Actor 간 라우팅/버스 → 미착수 (시기상조, Actor 수가 충분히 늘어난 후)
- Server WebSocket 브릿지 → Hook 유지 (UI 관심사)
- Traced interpreter opTrace 리셋 → Hook 유지 (인터프리터 밀결합)
