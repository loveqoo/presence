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
- 여러 FSM 합성 가능 (병렬 등)
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

### 포함
- `Transition` ADT (전이 규칙)
- `FSM` 타입 (transitions 집합 + initial state + id)
- `step` 순수 함수 `(fsm, state, command) → Either<rejection, {state, events}>`
- `parallel(a, b)` 합성 연산자
- FSM law 검증 테스트
- `sessionFSM` 최초 use case

### 보류 (이후 Phase 에서 판단)
- `compose` / `choice` 합성 연산자 — 실제 필요 증명 후
- `react(fsm, eventPattern, newFsmFactory)` — 이벤트 기반 FSM spawn
- FSM runtime (actor-like queue + 현재 state 보유자) — Phase 2
- Command envelope / DomainEventBus — Phase 2
- 추가 FSM (approve, delegate, connection) — Phase 3

### 스코프 밖 (당분간)
- Event sourcing (state 가 event stream 의 파생물)
- Cross-server FSM replication
- Property-based testing (fast-check)

---

## 2. Design Decisions

fun-fp-js 유지자의 정밀성 지적 5개를 전부 결정으로 확정.

### D1. `compose` 는 Phase 1 제외
**문제**: 제안 시 "f1 이 accept 한 event 로 f2 가 트리거" — 타입엔 E ⊂ C 제약 없음, 의미 불명확.
**결정**: Phase 1 에서 `compose` 제외. `parallel` 만 제공. 이벤트 기반 트리거가 필요하면 향후 `react` operator 로 분리 설계.

### D2. Rejection shape 통일
**문제**: `Transition.reject: string` vs `StepResult.Left: { reason, command, state }` 매핑 규칙 불명.
**결정**:
```js
// Transition 정의 — 간결
{ ..., reject: string | ((state, command) => string) }

// StepResult.Left — 풍부 (디버깅/감사 편의)
{
  reason: string,              // Transition.reject 에서 평가
  command: Command,            // 원 명령
  state: State,                // 거부 시점 상태
  transitionIndex: number,     // 매칭된 transition 의 배열 인덱스
}
```

### D3. Pattern 매칭은 첫 match 승리
**문제**: `from` / `on` 에 predicate 허용 시 다중 매치 가능 → Determinism 법칙 위반.
**결정**: `transitions` 배열을 **앞에서부터 순차 스캔**. 첫 번째 matching transition 이 승리. 이후 규칙은 무시. `step` 의 계약으로 문서화.

### D4. `parallel` event 순서
**문제**: "modulo event interleaving" 표현했지만 equivalence 관계 미정의.
**결정**: `parallel(a, b)` 의 events = `[...a.events, ...b.events]`. **자식 FSM 순서 고정**. Commutativity 법칙 **주장하지 않음** (순서 다른 것은 관찰 가능 다름). 각 자식 내부 순서만 보존 보장.

### D5. `emit` 순수성
**문제**: `(state, command) => Event[]` 가 pure 보장 안 됨 (부작용 시 Determinism 깨짐).
**결정**: **문서로 강제**. emit 함수는 pure 해야 함. 부작용 시 step 의 Determinism 법칙 위반. 런타임 강제 검증은 과함 — 테스트로 커버.

### 추가 결정

### D6. 합성 API = free function
`parallel(a, b)` 형태. Fluent chain (`a.parallel(b)`) 안 함. 테스트 / 합성 가시성 우선.

### D7. Event shape
```js
{
  topic: string,       // 필수. 'session.turn.started' 같은 dot-notation
  payload?: any,       // optional
  ts?: number,         // optional. 없으면 step 시점 Date.now() 주입
  source?: string,     // optional. 생성한 FSM id
}
```

### D8. Command shape
```js
{
  type: string,        // 필수. 'chat', 'cancel', 'approve' 등
  origin?: string,     // optional. 'tui:session-A', 'wui:...', 'agent:...'
  principal?: string,  // optional. 권한 주체 유저 ID
  payload?: any,       // optional. intent-specific
  ts?: number,         // optional
  id?: string,         // optional. Command 추적용 UUID
}
```

A2A / 멀티 UI 대비는 이 shape 에 이미 포함 (origin, principal). Phase 2 에서 Command envelope 로 확장.

### D9. Guard 는 동기만
Async guard 필요 시 command dispatch 이전에 외부에서 async 검증 후 동기 command 생성. FSM 내부는 동기 유지.

### D10. Initial state 필수
`FSM.initial` 은 필수 필드. 옵셔널 아님.

---

## 3. 타입 정의

```typescript
// 상태 패턴 — 값 또는 predicate
type StatePattern<S> = S | ((s: S) => boolean)

// 명령 패턴 — type string 또는 predicate
type CommandPattern = string | ((c: Command) => boolean)

// 전이 규칙 하나
type Transition<S, E> = {
  from: StatePattern<S>
  on: CommandPattern
  guard?: (state: S, command: Command) => boolean
  to?: S | ((state: S, command: Command) => S)
  emit?: E[] | ((state: S, command: Command) => E[])
  reject?: string | ((state: S, command: Command) => string)
}
// 불변식: to 와 reject 는 상호 배타. 둘 다 없으면 identity (no-op accept).

// FSM 정의
type FSM<S, E> = {
  id: string
  initial: S
  transitions: Transition<S, E>[]
}

// 명령
type Command = {
  type: string
  origin?: string
  principal?: string
  payload?: any
  ts?: number
  id?: string
}

// 이벤트
type Event = {
  topic: string
  payload?: any
  ts?: number
  source?: string
}

// step 결과
type StepResult<S, E extends Event> = Either<Rejection<S>, Accepted<S, E>>

type Rejection<S> = {
  reason: string
  command: Command
  state: S
  transitionIndex: number
}

type Accepted<S, E> = {
  state: S
  events: E[]
  transitionIndex: number   // 매칭된 transition 인덱스 (감사용)
}
```

---

## 4. 핵심 함수

### `step`
```js
step :: FSM<S, E> → S → Command → StepResult<S, E>
```

알고리즘:
1. `fsm.transitions` 앞에서부터 순차 스캔
2. 각 transition 에 대해 `from` 매칭 + `on` 매칭 + `guard` (있으면) 통과 확인
3. 모두 통과한 첫 transition 이 승리:
   - `reject` 이 있으면 `Left({ reason: evaluate(reject), command, state, transitionIndex })`
   - `to`/`emit` 이 있으면 `Right({ state: evaluate(to) ?? state, events: evaluate(emit) ?? [], transitionIndex })`
   - 둘 다 없으면 identity (`Right({ state, events: [], transitionIndex })`)
4. 매칭되는 transition 없으면 `Right({ state, events: [], transitionIndex: -1 })` (identity)

→ **매칭 안 되어도 reject 아님**. "정의되지 않은 전이는 no-op accept". 거부는 반드시 명시적 `reject` 규칙으로만.

### `parallel`
```js
parallel :: FSM<S1, E> → FSM<S2, E> → FSM<[S1, S2], E>
```

- 상태는 tuple `[s1, s2]`
- 양쪽 FSM 에 같은 command 전달
- 한 쪽이라도 reject 하면 전체 reject (첫 번째 실패한 쪽의 reason)
- 둘 다 accept 하면 state = `[s1', s2']`, events = `[...e1, ...e2]`

---

## 5. 법칙 (Laws)

### Identity transition
```
step(identity_fsm, s, c) ≡ Right({ state: s, events: [], transitionIndex: -1 })
```
where `identity_fsm = { id: 'id', initial: null, transitions: [] }` — 모든 command 가 no-op accept.

### Determinism
```
∀ fsm, s, c: step(fsm, s, c) always returns the same result
```
단 emit 함수, guard, `to` / `reject` 함수형이 모두 pure 일 때 성립 (D5).

### Rejection stability
```
step(fsm, s, c) = Left(_) → state s 는 변경되지 않음
```
부분 전이 없음.

### First-match
```
매칭되는 transitions[i] 중 최소 i 가 적용됨
```
D3 의 계약.

### parallel identity
```
parallel(identity_fsm, a) 는 a 와 observationally equivalent (state pair 제외)
parallel(a, identity_fsm) 동일
```

### parallel associativity
```
parallel(parallel(a, b), c) ≡ parallel(a, parallel(b, c))   -- nested tuple 이 flatten 된다는 전제
```

**Commutativity 는 주장 안 함** (D4).

---

## 6. fun-fp-js 와의 연결

### 내부 구현에서 재사용
```js
import fp from '@presence/core/lib/fun-fp.js'
const { Either } = fp

// step 이 반환하는 Either
return Either.Right({ state: ..., events: [...] })
// 또는
return Either.Left({ reason: ..., command, state, transitionIndex })
```

### 소비자 측 합성
step 결과가 Either 이므로 호출자가 `.fold`, `.chain`, `.map` 으로 자연스럽게 합성:

```js
const result = step(sessionFSM, current, command)
result.fold(
  rejection => logger.warn('command rejected', rejection),
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
packages/core/src/core/
├── fsm/
│   ├── fsm.js          ← FSM 타입, step, parallel 구현
│   ├── command.js      ← Command shape + helpers
│   ├── event.js        ← Event shape + helpers
│   └── laws.js         ← 법칙 검증 헬퍼 (테스트 전용)

packages/core/test/core/fsm/
├── fsm.test.js         ← step / parallel 단위 테스트
├── laws.test.js        ← 법칙 테스트 (identity, determinism, first-match 등)

packages/infra/src/infra/fsm/
├── session-fsm.js      ← sessionFSM 정의
```

Phase 1 은 위 구조까지. runtime / event bus / 추가 FSM 은 Phase 2+.

---

## 8. 첫 번째 use case — sessionFSM

### 현재 session 상태 모델링

현재 TurnController + executor 가 암묵적으로 관리하는 상태를 FSM 으로 명시화.

**상태**:
- `idle`
- `working` (턴 진행 중)
- `approving` (승인 대기)
- `cancelling` (cancel 요청됨, 종료 대기)

**Command**:
- `chat` (유저 입력)
- `approve` (승인 응답)
- `cancel` (ESC)
- `complete` (턴 완료)
- `abort_complete` (abort 확정)
- `failure_complete` (error 확정)

**Transitions** (일부):
```js
export const sessionFSM = {
  id: 'session',
  initial: 'idle',
  transitions: [
    { from: 'idle',       on: 'chat',              to: 'working',    emit: [{ topic: 'turn.started' }] },
    { from: 'working',    on: 'approve.request',   to: 'approving',  emit: [{ topic: 'approve.prompted' }] },
    { from: 'approving',  on: 'approve.response',  to: 'working',    emit: [{ topic: 'approve.resolved' }] },
    { from: 'working',    on: 'cancel',            to: 'cancelling', emit: [{ topic: 'cancel.requested' }] },
    { from: 'cancelling', on: 'abort_complete',    to: 'idle',       emit: [{ topic: 'turn.cancelled' }] },
    { from: 'working',    on: 'complete',          to: 'idle',       emit: [{ topic: 'turn.completed' }] },
    { from: 'working',    on: 'failure_complete',  to: 'idle',       emit: [{ topic: 'turn.failed' }] },
    // 명시적 거부 규칙
    { from: 'working',    on: 'chat',              reject: 'session-busy' },
    { from: 'approving',  on: 'chat',              reject: 'awaiting-approval' },
    { from: 'cancelling', on: 'chat',              reject: 'cancelling' },
  ],
}
```

이 FSM 이 Phase 1 의 검증 수단. 기존 동작이 이 규칙으로 재현 가능해야 함.

### Phase 1 에서의 통합 수준

- `sessionFSM` 은 정의만 하고 **기존 경로 대체 안 함** (공존)
- 기존 TurnController 가 내는 state 전이와 FSM step 의 결과가 **일치** 하는지 테스트만
- 실제 swap 은 Phase 2 (runtime 도입 시)

→ 점진적 migration. 현재 동작 깨지지 않음.

---

## 9. 구현 순서 (Phase 1)

1. **`fsm.js` 최소 구현** — 타입, step, identity, parallel. 순수 함수만.
2. **`laws.js`** — identity, determinism, first-match, rejection-stability, parallel-identity 검증 헬퍼.
3. **단위 테스트** — light/fan 같은 장난감 FSM 으로 검증.
4. **`session-fsm.js`** — 실제 session 상태를 FSM 데이터로 기술.
5. **검증 테스트** — 기존 TurnController 의 시나리오 몇 개를 `sessionFSM` step 으로 재현해서 state 전이 일치 확인.

각 단계 독립 커밋 가능. Phase 1 전체 1주 예상.

---

## 10. 향후 Phase (Phase 2+)

### Phase 2: Runtime + Event Bus
- `FSMRuntime` — FSM instance 실행기 (큐, current state, event publish)
- `DomainEventBus` — topic pub/sub
- 이 단계까지 가야 "TUI + WUI 동시 연결" 같은 멀티 클라이언트 시나리오 실제 가동 가능

### Phase 3: 추가 FSM
- `approveFSM` — 승인 게이트
- `delegateFSM` — A2A 위임 상태
- `connectionFSM` — WS 연결 상태

### Phase 4: 기존 경로 swap
- TurnController → sessionFSM runtime 으로 교체
- 기존 imperative API (`markLastTurnCancelledSync` 등) 를 FSM transition 으로 이관

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

- 2026-04-18: 초안. fun-fp-js 유지자 피드백 (scope + precision 5건) 전부 반영. Presence 자체 구현 확정. Phase 1 scope 정의.
