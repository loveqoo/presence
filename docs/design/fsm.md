# FSM Design — Transition Algebra for Presence

**Status**: Design. Phase 1 PoC 전 단계.
**Owner**: Presence core.
**관련 문서**: `docs/archive/fun-fp-js-transition-algebra-commission.md` (외부 의뢰 거절 기록 — scope 판단 근거), `docs/design-philosophy.md` (북극성).

---

## 0. 배경

### 왜 필요한가

**문제**: TUI + WUI + A2A 등 다중 명령 원천이 예상되는 상황에서 "상태 전이 규칙" 이 코드 전체에 흩어지면 race / 거부 / 관찰성 문제가 재발. FP-61 메시지 아키텍처 refactor 이전의 이중 출처 문제가 전형적 예.

**목표**: 상태 전이를 **first-class value** 로 표현해서:
- 테스트 간단 (순수 함수 step)
- 거부 규칙이 **데이터** (명시적)
- 여러 FSM 합성 가능 (product composition)
- Command/Event 분리로 A2A / 멀티 UI 대응

### 위치 — fun-fp-js 가 아님

fun-fp-js 유지자 피드백을 받아 다음을 확정:

- fun-fp-js 의 scope = **Static Land typeclass 대수** (Functor/Monad/Traversable 등)
- FSM 은 **Arrow 카테고리** 의 도메인 알고리즘. typeclass 외부.
- `StateT × WriterT × EitherT` 스택의 **응용** 이므로 application-level 이 맞음
- Presence 자체 구현. fun-fp-js 의 State/Writer/Either 를 **소비** 만.

별도 npm 패키지로 분리 여부는 성숙 후 판단.

---

## 1. Scope

### 포함 (Phase 1)
- `Transition` ADT (전이 규칙)
- `FSM` 타입 (transitions 집합 + initial state + id + onUnknown)
- `step` 순수 함수 — `(fsm, state, command) → Either<Rejection, Accepted>`
- **`product({ key: fsm })`** 조합자 — 중심 API
- `parallel(a, b)` — `product` 의 2항 alias (re-export)
- FSM law 검증 테스트
- `turnGateFSM` 최초 use case (scope 좁게)

### 보류 (이후 Phase 에서 판단)
- `react(fsm, eventPattern, newFsmFactory)` — 이벤트 기반 FSM spawn / inter-FSM coordination
- FSM runtime (actor-like queue + 현재 state 보유자) — Phase 2
- Command envelope / DomainEventBus — Phase 2
- 추가 FSM (approve, delegate, connection) — Phase 3
- **SessionFSM** = `product({ turnGate, approve, delegate, connection })` — Phase 3

### 스코프 밖 (당분간)
- Event sourcing (state 가 event stream 의 파생물)
- Cross-server FSM replication
- Property-based testing (fast-check)
- `compose` (순차 합성) / `choice` (선택) — 필요성 증명 전 도입하지 않음

---

## 2. Design Decisions

fun-fp-js 유지자의 정밀성 지적 + 이후 리뷰 피드백을 전부 결정으로 확정.

### D1. `compose` 는 Phase 1 제외
**문제**: 제안 시 "f1 이 accept 한 event 로 f2 가 트리거" — 타입엔 E ⊂ C 제약 없음, 의미 불명확.
**결정**: Phase 1 에서 `compose` 제외. `product` 만 제공. 이벤트 기반 트리거가 필요하면 향후 `react` operator 로 분리 설계.

### D2. Rejection shape 분류 + 요약
**문제**: 단순 string reason 은 aggregation 에서 노이즈. "관심 없음" vs "명시적 거부" 구분 필요.
**결정**:
```js
// Transition 정의 — 간결
{ ..., reject: string | ((state, command) => string) }

// StepResult.Left — 풍부 (감사/디버깅 편의)
Left({
  command,
  state,
  reasons: [
    { fsm: string, reason: string, kind: 'explicit' | 'no-match' | 'guard-failed' },
    ...
  ],
  primaryReason: string,      // 외부 표시용 요약 (explicit 우선)
})
```
**Kind 분류**:
- `explicit` — Transition 의 `reject` 규칙 매칭
- `no-match` — 매칭되는 transition 없음 (onUnknown 기본)
- `guard-failed` — 매칭했으나 guard 통과 실패
**소비 규칙**:
- 감사/디버깅: `reasons` 전체
- 사용자 표시: `primaryReason` (explicit 우선, 없으면 'unhandled')

### D3. Pattern 매칭은 첫 match 승리
**문제**: `from` / `on` 에 predicate 허용 시 다중 매치 가능 → Determinism 법칙 위반.
**결정**: `transitions` 배열을 **앞에서부터 순차 스캔**. 첫 번째 matching transition 이 승리. 이후 규칙은 무시. `step` 의 계약으로 문서화.
**강화**: transition 배열 순서는 **스펙 불변식**. 재배열은 의미론적으로 다른 FSM (§5 INV-FSM-ORDER).

### D4. `product` event 순서 = key array 고정
**문제**: "modulo event interleaving" 표현했지만 equivalence 관계 미정의.
**결정**: `product(fsms)` 는 FSM key 순서대로 events concatenate. **자식 FSM 순서 고정**. Commutativity 법칙 **주장하지 않음**.
**구현**: JS object 순서 의존 X. product 생성 시 `Object.keys(fsms)` 를 배열로 내부 저장 (`keys` 필드), aggregation 은 이 array 순서로 순회.

### D5. `emit` 순수성
**문제**: `(state, command) => Event[]` 가 pure 보장 안 됨 (부작용 시 Determinism 깨짐).
**결정**: **문서로 강제**. emit 함수는 pure 해야 함. 부작용 시 step 의 Determinism 법칙 위반. 런타임 강제 검증은 과함.

### D6. step 은 Event.ts 를 주입하지 않음
**문제**: step 이 `Date.now()` 를 주입하면 Determinism 깨짐.
**결정**: **step 은 timestamps 를 건드리지 않음**. `emit` 이 반환한 event 배열 그대로 pass-through. `ts` 는 envelope / Runtime 레이어에서 주입 (Phase 2).
**Event.ts** 는 optional 필드로 존재. step 은 설정 안 함.

### D7. 합성 API = free function, product 중심
**결정**:
- 주 API: `product({ key: fsm })` — 문서/설계 중심
- 선택 alias: `parallel(a, b) = product({ left: a, right: b })` — re-export
- fluent chain (`a.product(b)`) 안 함

### D8. Event / Command shape
```js
type Command = {
  type: string,        // 필수. 'chat', 'cancel' 등
  origin?: string,     // optional. 'tui:X', 'wui:Y', 'agent:Z'
  principal?: string,  // optional. 권한 주체
  payload?: any,       // optional
  id?: string,         // optional. UUID
  // ts 는 envelope 층이 책임 (step 과 무관)
}

type Event = {
  topic: string,       // 필수. 'session.turn.started' 같은 dot-notation
  payload?: any,       // optional
  source?: string,     // optional. 생성한 FSM id
  // ts 는 envelope 층이 책임
}
```

### D9. Guard 는 동기만
Async guard 필요 시 command dispatch 이전에 외부에서 async 검증 후 동기 command 생성. FSM 내부는 동기 유지.

### D10. Initial state 필수
`FSM.initial` 은 필수 필드. 옵셔널 아님.

### D11. onUnknown 기본 'no-match' (개별) + product aggregation 에서 non-fatal
**문제**: 매칭 없으면 silent success 는 관찰성 파괴. 하지만 product broadcast 에서 "관심 없는 FSM 은 통과" 도 필요.
**결정**:
- **개별 FSM step** 에서 매칭 없음 → `Left({ reasons: [{ fsm, reason: 'no matching transition', kind: 'no-match' }], ... })` (reject 의 subset 이지만 kind 로 구분)
- **product aggregation** 에서 `no-match` 는 **non-fatal**:
  - 하나라도 `accepted` → 전체 Right (state 병합, events concat)
  - 0 accepted + 1개 이상 `explicit` reject → 전체 Left, primaryReason = explicit 중 첫
  - 0 accepted + 전부 `no-match` → 전체 Left, primaryReason = 'unhandled'
- Silent no-op 제거. "아무도 처리 못함" 이 명시적 신호.

### D12. Empty product = identity
**결정**: `product({})` 는 identity FSM.
- State = `{}`
- 모든 command 에 대해 `Right({ state: {}, events: [], transitionIndex: -1 })`
- Law 의 identity 원소로 역할. 실사용은 금지 (혼란 방지) — 단 law/test 유용.

### D13. turnGateFSM — Phase 1 실전 scope
**결정**: Phase 1 실전 use case 는 **`turnGateFSM`** 하나. 현재 세션의 `turnState` 축만 담당 (idle / working / cancelling). approve / delegate / connection / reconnecting 등 다른 직교 축은 Phase 3 에서 별도 FSM 으로, `product` 로 합성.
**Naming**: `sessionFSM` 아님. `sessionFSM = product({ turnGate, approve, delegate, connection })` 은 Phase 3 의 결과.

---

## 3. 타입 정의

```typescript
// ──── 패턴 ────
type StatePattern<S> = S | ((s: S) => boolean)
type CommandPattern = string | ((c: Command) => boolean)

// ──── 전이 규칙 ────
type Transition<S, E> = {
  from: StatePattern<S>
  on: CommandPattern
  guard?: (state: S, command: Command) => boolean
  to?: S | ((state: S, command: Command) => S)
  emit?: E[] | ((state: S, command: Command) => E[])
  reject?: string | ((state: S, command: Command) => string)
}
// 불변식: to 와 reject 는 상호 배타. 둘 다 없으면 identity transition.

// ──── FSM 정의 ────
type FSM<S, E> = {
  id: string
  initial: S
  transitions: Transition<S, E>[]
  onUnknown?: 'no-match'   // D11 기본값. 현재 다른 값 없음 (향후 'ignore' 고려 가능)
}

// ──── Product (조합) ────
type Product<M extends Record<string, FSM<any, Event>>> = FSM<
  { [K in keyof M]: M[K]['initial'] },   // NamedStateMap
  Event
> & {
  keys: (keyof M)[]                      // D4: key 순서 배열 고정
  children: M
}

// ──── Command / Event ────
type Command = {
  type: string
  origin?: string
  principal?: string
  payload?: any
  id?: string
}

type Event = {
  topic: string
  payload?: any
  source?: string   // 생성한 FSM id
}

// ──── Step 결과 ────
type StepResult<S, E> = Either<Rejection<S>, Accepted<S, E>>

type Rejection<S> = {
  command: Command
  state: S
  reasons: Array<{
    fsm: string,
    reason: string,
    kind: 'explicit' | 'no-match' | 'guard-failed',
    transitionIndex?: number,
  }>
  primaryReason: string   // D2 요약
}

type Accepted<S, E> = {
  state: S
  events: E[]
  transitionIndex?: number   // 단일 FSM. product 면 undefined
  perFsm?: Record<string, { state, events, transitionIndex }>   // product 디버깅용
}
```

---

## 4. 핵심 함수

### `step` (단일 FSM)

```
step :: FSM<S, E> → S → Command → StepResult<S, E>
```

**알고리즘**:
1. `fsm.transitions` 앞에서부터 순차 스캔 (D3 first-match).
2. 각 transition:
   - `from` 매칭 확인 (값 또는 predicate)
   - `on` 매칭 확인 (type 일치 또는 predicate)
   - `guard` 있으면 평가. false 이면 **이 transition 만 skip, 스캔 계속**. 단 마지막 reasons 에 `{ kind: 'guard-failed' }` 기록.
   - 모두 통과하면 승리:
     - `reject` 있으면 `Left({ reasons: [{ kind: 'explicit', reason: evaluate(reject), ... }], primaryReason: evaluate(reject), ... })`
     - `to` 또는 `emit` 있으면 `Right({ state, events, transitionIndex })`
     - 둘 다 없으면 identity transition: `Right({ state, events: [], transitionIndex })`
3. 매칭되는 transition 없음 → **`Left({ reasons: [{ kind: 'no-match', reason: 'no matching transition', fsm: fsm.id }], primaryReason: 'unhandled' })`** (D11).

**⚠ 중요**: step 은 ts 를 건드리지 않음 (D6). emit 이 반환한 events 그대로 pass-through.

### `product` (조합자)

```
product :: { [key: string]: FSM<_, Event> } → Product
```

**구축**: product 는 FSM 인터페이스를 만족하는 값. 내부에 `children` (원본 FSMs) + `keys` (순서 array) 보유.

**step 오버라이드** (product 의 step):
```
step(productFsm, namedState, command):
  results = productFsm.keys.map(key =>
    [key, step(productFsm.children[key], namedState[key], command)]
  )

  accepted = results.filter(([_, r]) => r.isRight)

  // Aggregation (D11)
  if (accepted.length >= 1):
    newState = productFsm.keys.reduce((acc, key) => {
      const r = results.find(([k]) => k === key)[1]
      acc[key] = r.isRight ? r.value.state : namedState[key]   // reject 는 상태 불변
      return acc
    }, {})
    events = productFsm.keys.flatMap(key => {
      const r = results.find(([k]) => k === key)[1]
      return r.isRight ? r.value.events : []
    })
    return Right({ state: newState, events, perFsm: ... })

  // 0 accepted
  allReasons = results.flatMap(([key, r]) =>
    r.isLeft ? r.value.reasons.map(x => ({ ...x, fsm: key })) : []
  )
  hasExplicit = allReasons.some(r => r.kind === 'explicit')
  primaryReason = hasExplicit
    ? allReasons.find(r => r.kind === 'explicit').reason
    : 'unhandled'
  return Left({ command, state: namedState, reasons: allReasons, primaryReason })
```

### `parallel` (convenience alias)

```js
const parallel = (a, b) => product({ left: a, right: b })
```

단 한 줄. 2항 별칭. 문서 중심이 아님. 사용하지 않아도 됨.

---

## 5. 법칙 (Laws)

### INV-FSM-ORDER (transition 순서 불변식)
```
transitions 배열의 순서는 step 의 결정성에 기여하는 스펙 계약.
재배열은 semantically 다른 FSM.
```

### Identity transition
```
step(identity_fsm, s, c) ≡ Right({ state: s, events: [], transitionIndex: -1 })
```
`identity_fsm = { id: 'id', initial: null, transitions: [] }` 의 경우 D11 에 의해 매칭 없음 → Left(no-match). 즉 **빈 transitions 는 identity 가 아님**.
실제 identity 는 empty product = `product({})` (D12).

### Determinism (D5, D6 전제)
```
∀ fsm, s, c: step(fsm, s, c) = step(fsm, s, c)    (동일 결과)

전제: emit / guard / to / reject 함수는 모두 pure. step 자신은 ts 등 외부 상태 참조 없음.
```

### Rejection stability
```
step(fsm, s, c) = Left(_) → s 는 변경되지 않음. 부분 전이 없음.
```

### First-match
```
매칭되는 transitions[i] 중 최소 i 가 적용됨. 다른 match 는 무시.
```

### Product identity (D12)
```
product({}) 의 step 은 모든 command 에 대해 Right({ state: {}, events: [], transitionIndex: -1 })
```

### Product associativity (up to renaming)
```
product({ a, b: product({ c, d }) }) 와 product({ a, b, c, d }) 는 state map 구조만 다름.
Transition 의 semantic 은 동일.
```

### Product rejection aggregation (D11 명세)
```
∀ fsm ∈ children, r_fsm = step(fsm, s_fsm, c):

(a) ∃ fsm: r_fsm = Right(_)
    → product step = Right(merged_state, concat_events)
    
(b) ∀ fsm: r_fsm = Left(_) ∧ ∃ reason ∈ r_fsm.reasons: kind='explicit'
    → product step = Left(all_reasons, primaryReason = first_explicit.reason)
    
(c) ∀ fsm: r_fsm = Left(_) ∧ ∀ reason: kind='no-match'
    → product step = Left(all_reasons, primaryReason = 'unhandled')
```

### Product state slot isolation
```
product step 이 accept 하면, reject 한 child FSM 의 state slot 은 불변.
```

**Commutativity 는 주장 안 함** — key 순서가 event 순서에 반영됨 (D4).

---

## 6. fun-fp-js 와의 연결

### 내부 구현에서 재사용
```js
import fp from '@presence/core/lib/fun-fp.js'
const { Either } = fp

// step 이 반환하는 Either
return Either.Right({ state, events, transitionIndex })
return Either.Left({ command, state, reasons, primaryReason })
```

### 소비자 측 합성
step 결과가 Either 이므로 호출자가 `.fold` / `.chain` / `.map` 으로 자연스럽게 합성:

```js
const result = step(sessionFSM, current, command)
result.fold(
  rejection => logger.warn('command rejected', rejection.primaryReason, rejection.reasons),
  accepted => {
    reactiveState.set(STATE_PATH.TURN_STATE, accepted.state)
    accepted.events.forEach(e => eventBus.publish(e))
  },
)
```

### 필요하면 모나드 스택 활용
복잡한 조합이 필요하면 전이 로직을 `StateT × WriterT × EitherT` 로 lift 가능. 단 Phase 1 에서는 단순 `Either` 반환으로 충분.

---

## 7. 파일 layout

```
packages/core/src/core/fsm/
├── fsm.js          ← Transition, FSM, step, identity
├── product.js      ← product 조합자 + parallel re-export
├── command.js      ← Command shape + helpers
├── event.js        ← Event shape + helpers
├── laws.js         ← 법칙 검증 유틸 (테스트 전용)
└── index.js        ← public export

packages/core/test/core/fsm/
├── fsm.test.js         ← step / rejection kinds / first-match
├── product.test.js     ← product aggregation / rejection rules
├── laws.test.js        ← 법칙 (identity, determinism, ordering, product laws)

packages/infra/src/infra/fsm/
├── turn-gate-fsm.js    ← turnGateFSM 정의 (Phase 1 실전)
```

Phase 1 은 위 구조까지. runtime / event bus / 추가 FSM 은 Phase 2+.

---

## 8. Use cases

### 8.1 turnGateFSM (Phase 1 실전 scope)

**담당**: 현재 세션의 `turnState` 축 하나 — idle ↔ working ↔ cancelling.

**의도적으로 배제**: `_approve`, `events.queue`, `delegates.pending`, `_reconnecting` 등 다른 직교 축. Phase 3 에서 각자 FSM.

```js
export const turnGateFSM = {
  id: 'turnGate',
  initial: 'idle',
  transitions: [
    // Accept paths
    { from: 'idle',       on: 'chat',             to: 'working',    emit: [{ topic: 'turn.started' }] },
    { from: 'working',    on: 'cancel',           to: 'cancelling', emit: [{ topic: 'cancel.requested' }] },
    { from: 'working',    on: 'complete',         to: 'idle',       emit: [{ topic: 'turn.completed' }] },
    { from: 'working',    on: 'failure',          to: 'idle',       emit: [{ topic: 'turn.failed' }] },
    { from: 'cancelling', on: 'abort_complete',   to: 'idle',       emit: [{ topic: 'turn.cancelled' }] },

    // Explicit rejections (D2 kind='explicit')
    { from: 'working',    on: 'chat',   reject: 'session-busy' },
    { from: 'cancelling', on: 'chat',   reject: 'cancelling-in-progress' },
    { from: 'cancelling', on: 'cancel', reject: 'already-cancelling' },
  ],
}
```

### 8.2 장난감 product 검증 예제

Phase 1 에서 product 의 법칙 / aggregation 을 검증하는 단순 예:

```js
const lightFSM = makeFSM('light', 'off', [
  T({ from: 'off', on: 'toggle', to: 'on',  emit: [{ topic: 'light.on' }] }),
  T({ from: 'on',  on: 'toggle', to: 'off', emit: [{ topic: 'light.off' }] }),
])

const fanFSM = makeFSM('fan', 'off', [
  T({ from: 'off', on: 'toggle', to: 'on',  emit: [{ topic: 'fan.on' }] }),
  T({ from: 'on',  on: 'toggle', to: 'off', emit: [{ topic: 'fan.off' }] }),
])

const roomFSM = product({ light: lightFSM, fan: fanFSM })

step(roomFSM, { light: 'off', fan: 'off' }, { type: 'toggle' })
// → Right({ state: { light: 'on', fan: 'on' }, events: [{ topic: 'light.on' }, { topic: 'fan.on' }] })

step(roomFSM, { light: 'off', fan: 'off' }, { type: 'other' })
// → Left({ reasons: [no-match × 2], primaryReason: 'unhandled' })
```

### 8.3 Phase 3 의 SessionFSM (예고)

Phase 3 에서:
```js
export const sessionFSM = product({
  turnGate:   turnGateFSM,
  approve:    approveFSM,
  delegate:   delegateFSM,
  connection: connectionFSM,
})
```
**결과 state**: `{ turnGate: 'idle', approve: 'none', delegate: 'none', connection: 'connected' }`

각 FSM 은 자기 axis 만 관리. Command broadcast. 한 명령이 여러 FSM 에 동시 의미 있을 수 있음 (예: `/clear` → turnGate reset + delegate clear).

---

## 9. 구현 순서 (Phase 1)

1. **`fsm.js`** — Transition, FSM, step, identity. Either-based 반환.
2. **`product.js`** — product 조합자 + aggregation 구현 + parallel alias.
3. **`command.js` / `event.js`** — shape 정의 + helpers (`makeCommand`, `makeEvent`).
4. **`laws.js`** — identity / determinism / first-match / rejection-stability / product identity/associativity/aggregation 헬퍼.
5. **단위 테스트** — light/fan 장난감 FSM 으로 법칙 전부 검증.
6. **`turn-gate-fsm.js`** — 실제 turnState 전이를 FSM 데이터로 기술.
7. **검증 테스트** — 기존 TurnController 의 핵심 시나리오를 `step(turnGateFSM, ...)` 으로 재현. 기존 동작 일치 확인.

각 단계 독립 커밋 가능. Phase 1 전체 1주 예상.

**중요**: Phase 1 은 **기존 경로를 대체하지 않음**. `turnGateFSM` 은 정의만. 실제 TurnController swap 은 Phase 4.

---

## 10. 향후 Phase

### Phase 2: Runtime + EventBus
- `FSMRuntime` — FSM instance 실행기 (큐, current state 보유자, event publish)
- `DomainEventBus` — topic 기반 pub/sub
- `react(fsm, eventPattern, commandFactory)` — 이벤트 → 다음 command routing (FSM 간 coordination)
- Command envelope (`{ id, origin, principal, intent, ts }`)
- 이 단계까지 가야 "TUI + WUI 동시 연결" 같은 멀티 클라이언트 시나리오 가동 가능

### Phase 3: 추가 FSM + SessionFSM 합성
- `approveFSM` — none/waiting/approved/rejected
- `delegateFSM` — none/pending/running/completed/failed
- `connectionFSM` — connecting/connected/reconnecting/disconnected
- `sessionFSM = product({ turnGate, approve, delegate, connection })` 최초 등장
- 각 FSM 의 react 규칙 (예: approveFSM resolved → turnGateFSM complete)

### Phase 4: 기존 경로 swap
- TurnController → sessionFSM runtime 으로 교체
- 기존 imperative API (`markLastTurnCancelledSync` 등) 를 FSM transition 으로 이관
- Event bus 구독자가 TUI/WS 브로드캐스트 담당

각 Phase 는 **블로킹 없이 독립 진행**. 중간에 멈춰도 앞 Phase 이득 보존.

---

## 11. 열린 질문 (답하지 않음, 기록만)

이 문서에서 **확정하지 않은** 것들. Phase 2 이상에서 판단:

1. FSM event → 다른 FSM command 의 routing 규약 (react operator 의 shape)
2. Command envelope 의 authorization 정책 (`principal` 검증 레이어 위치)
3. Event log 영속화 여부 (메모리 vs file vs 데이터베이스)
4. A2A 원격 FSM 과의 동기화 프로토콜
5. FSM state snapshot 의 직렬화 포맷 (replay 용)

각각은 해당 Phase 의 설계 문서에서 다룸.

---

## Changelog

- 2026-04-18: 초안. fun-fp-js 유지자 피드백 (scope + precision 5건) 반영. Presence 자체 구현 확정. Phase 1 scope = sessionFSM.
- 2026-04-19: 2차 리뷰 피드백 반영.
  - D6: step 의 ts 주입 제거 (Determinism 법칙 회복)
  - D11: onUnknown 정책 — 개별 FSM no-match + product aggregation non-fatal
  - D13: sessionFSM → turnGateFSM scope 좁힘. SessionFSM 은 Phase 3 product 결과.
  - D2: rejection reasons 분류 (explicit/no-match/guard-failed) + primaryReason 요약
  - D4: event 순서 = FSM key array 고정 (JS object 순서 의존 X)
  - D7: 주 API = product. parallel 은 2항 alias
  - D12: empty product = identity
  - §5 INV-FSM-ORDER 불변식 격상
