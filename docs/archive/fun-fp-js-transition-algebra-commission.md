# [Request] Transition Algebra — state machines as composable values

## TL;DR

상태 기계 (FSM) 를 **first-class 합성 가능한 값** 으로 표현하는 primitive `Transition` / `FSM` / `step` 을 fun-fp-js 에 추가 제안합니다.

`StateT` 가 "상태 + 비동기" 를 합성 가능한 값으로 만든 것과 동일한 맥락에서, `Transition` 은 "상태 + 명령 → (상태', 이벤트들) 또는 거부" 를 합성 가능한 값으로 만듭니다. 본질적으로 `StateT × WriterT × EitherT` 스택 위의 Kleisli arrow 로, 기존 fun-fp-js 모나드 계층 위에 자연스럽게 구축됩니다.

---

## 배경

### 선례

StateT 추가 의뢰 시 공유했던 기준 (이론적 토대 / 대수적 법칙 / 기존 primitives 와의 조합성) 을 이번에도 동일하게 만족합니다.

### FSM 의 기존 구현 방식과 한계

| 방식 | 예 | 한계 |
|---|---|---|
| Actor with `become()` | Akka | 상태가 인스턴스에 숨겨져 직렬화/시각화/테스트 어려움 |
| Compiler-generated | Kotlin suspend | 상태 전이가 컴파일러 내부로 불투명 |
| `xstate` / chart libs | - | 합성 법칙이 약하고 모나드 스택에 통합 안 됨 |
| Imperative switch | 일반 JS | 규칙이 코드에 흩어짐. 합성 불가 |

### 우리가 원하는 것

**FSM 을 값으로 표현하고, 순수 함수로 step 하고, 값끼리 합성할 수 있게.**

```js
// FSM 정의 = 데이터
const lightFSM = FSM('light', 'off', [
  Transition({ from: 'off', on: 'toggle', to: 'on',  emit: ['light.on'] }),
  Transition({ from: 'on',  on: 'toggle', to: 'off', emit: ['light.off'] }),
])

// step 은 순수 함수
step(lightFSM, 'off', { type: 'toggle' })
// → Right({ state: 'on', events: ['light.on'] })

// FSM 끼리 합성
const roomFSM = parallel(lightFSM, fanFSM)
step(roomFSM, ['off', 'off'], { type: 'toggle' })
// → Right({ state: ['on', 'on'], events: ['light.on', 'fan.on'] })
```

---

## 제안 API

### 타입

```typescript
type Transition<S, C, E> = {
  from: S | ((s: S) => boolean)        // state pattern (value or predicate)
  on: string | ((c: C) => boolean)     // command pattern (type string or predicate)
  guard?: (s: S, c: C) => boolean      // optional precondition
  to?: S | ((s: S, c: C) => S)         // next state (accepting path)
  emit?: E[] | ((s: S, c: C) => E[])   // events emitted
  reject?: string                      // rejection reason (rejecting path)
}

type FSM<S, C, E> = {
  id: string
  initial: S
  transitions: Transition<S, C, E>[]
}

type StepResult<S, E> = Either<
  { reason: string, command: C, state: S },   // Left: rejected
  { state: S, events: E[] }                   // Right: accepted
>
```

### 핵심 함수

```typescript
// 상태 + 명령 → 결과 (순수)
step<S, C, E>(fsm: FSM<S, C, E>, state: S, command: C): StepResult<S, E>

// FSM 합성 연산자
compose<S1, S2, C, E>(
  f1: FSM<S1, C, E>,
  f2: FSM<S2, C, E>
): FSM<[S1, S2], C, E>   // 순차 — f1 이 accept 한 이벤트로 f2 가 트리거

parallel<S1, S2, C, E>(
  f1: FSM<S1, C, E>,
  f2: FSM<S2, C, E>
): FSM<[S1, S2], C, E>   // 병렬 — 같은 명령을 양쪽 모두에 전달

choice<S, C, E>(
  f1: FSM<S, C, E>,
  f2: FSM<S, C, E>
): FSM<S, C, E>          // 선택 — 먼저 accept 하는 쪽이 이김
```

---

## 법칙 (Laws)

### Identity transition
```
step(id, s, c) ≡ Right({ state: s, events: [] })
```
where `id` 는 transitions 비어있는 FSM (모든 명령 accept, no-op, no events).

### Left/right identity of compose
```
compose(id, f) ≡ f
compose(f, id) ≡ f
```

### Associativity of compose
```
compose(compose(a, b), c) ≡ compose(a, compose(b, c))
```

### Commutativity of parallel (modulo event interleaving)
```
parallel(a, b) ≡ parallel(b, a)
```
각 FSM 내 이벤트 순서 보존. FSM 간 interleaving 은 equivalent 로 간주.

### Determinism
```
step(fsm, s, c) 는 결정론적. 동일 입력 → 동일 출력.
```

### Rejection stability
```
step(fsm, s, c) = Left(_) → 상태 s 는 변경되지 않음. 부분 전이 없음.
```

---

## 기존 fun-fp-js 와의 관계

Transition Algebra 는 기존 모나드의 **응용** 으로 해석 가능:

```
Transition<S, C, E> ≈ C → StateT<S, Writer<E[], Either<Rejection, Unit>>>
```

즉 `step` 은 `StateT × WriterT × EitherT` 스택 위의 Kleisli arrow 로 재구성 가능.

**재사용되는 primitives**:
- `State` / `StateT` — 상태 전이
- `Writer` — 이벤트 축적 (`tell`)
- `Either` — 거부 분기
- `Reader` — 외부 의존성 (clock, logger 등, 필요 시)

**새로 추가되는 것**:
1. `Transition` ADT (규칙을 데이터로)
2. `step` interpreter (패턴 매칭)
3. 합성 연산자 (`compose`, `parallel`, `choice`)
4. FSM law 검증 utility

---

## Category-theoretic 배경

### 관련 추상

- **Arrow** (`Control.Arrow`) — 입출력 변환의 일반화
- **Machine** ([Haskell `machines`](https://hackage.haskell.org/package/machines)) — stateful stream processor
- **Transducer** (Clojure) — composable algorithmic transformations
- **Moore / Mealy machines** — classical automata

### 위치

제안하는 Transition Algebra 는 **Mealy machine** (출력이 상태 + 입력에 의존) 을 first-class value 로 만든 형태. Haskell `machines` 의 `Mealy` 와 거의 동형:

```
Mealy<I, O>            = I → (O, Mealy<I, O>)
Transition<S, C, E>    ≈ S → C → Either<R, (S, E[])>   -- 명시적 상태 + 거부 가능
```

명시적 상태 노출 + 이벤트 emit + rejection path 가 추가된 것.

---

## Use Cases

### 1. Session FSM (대화 세션 생명주기)
```
idle → working → (approving ↔ working) → idle
              ↘ cancelling → idle
```
규칙 위반 시 명확한 거부 (예: working 중 `chat` → `reject: 'session-busy'`).

### 2. Approve FSM (승인 게이트)
```
waiting → approved | rejected
```

### 3. Connection FSM (WS 연결)
```
connecting → connected → reconnecting → disconnected
                       ↘ (close) disconnected
```

### 4. Delegate FSM (작업 위임)
```
pending → running → completed | failed
```

### 5. Light/Fan (장난감 예제)
위의 `lightFSM` / `fanFSM` 합성 — 단순 검증용.

---

## 사용 예 (짧은 스니펫)

```js
import fp from 'fun-fp-js'
const { FSM, Transition, step, parallel, laws } = fp

// 1. 단순 FSM
const lightFSM = FSM('light', 'off', [
  Transition({ from: 'off', on: 'toggle', to: 'on',  emit: ['light.on'] }),
  Transition({ from: 'on',  on: 'toggle', to: 'off', emit: ['light.off'] }),
])

// 2. step
step(lightFSM, 'off', { type: 'toggle' })
// → Either.Right({ state: 'on', events: ['light.on'] })

step(lightFSM, 'on', { type: 'noop' })
// → Either.Right({ state: 'on', events: [] })   // no matching transition = identity

// 3. 거부 규칙
const strictFSM = FSM('strict', 'idle', [
  Transition({ from: 'idle',    on: 'start', to: 'running', emit: ['started'] }),
  Transition({ from: 'running', on: 'start', reject: 'already-running' }),
])

step(strictFSM, 'running', { type: 'start' })
// → Either.Left({ reason: 'already-running', command: ..., state: 'running' })

// 4. 합성
const roomFSM = parallel(lightFSM, fanFSM)
step(roomFSM, ['off', 'off'], { type: 'toggle' })
// → Either.Right({ state: ['on', 'on'], events: ['light.on', 'fan.on'] })

// 5. 법칙 검증
laws.checkIdentity(lightFSM)       // ok
laws.checkAssociativity(a, b, c)   // ok
```

---

## 요청 사항

1. `Transition` / `FSM` / `step` 핵심 API
2. `compose` / `parallel` / `choice` 합성 연산자
3. FSM law 검증 유틸리티 (기존 fun-fp-js law 스타일 준수)
4. `machines` / transducer / Arrow 와의 관계를 문서에서 언급

---

## 토의 포인트 (유지자 결정 영역)

API 설계에서 정해야 할 지점들 — 제가 의견은 있지만 fun-fp-js 의 기존 네이밍/스타일에 맞춰주시면 됩니다.

1. **명명**: `FSM` vs `Machine` vs `Process` vs `Transducer`
2. **Transition shape**: `{ from, on, to, emit, reject }` 필드 구성
3. **Pattern 표현**: `from` 이 값만 받을지, predicate 도 받을지
4. **Rejection 의 shape**: 단순 string vs 구조화된 reason 객체
5. **Guard 함수**: 동기만 vs async 지원
6. **합성 API**: fluent (`a.compose(b)`) vs free function (`compose(a, b)`)
7. **이벤트 타입**: tagged union 강제 여부 (`{ type: string, ...payload }`)
8. **Initial state 처리**: `FSM.initial` 필수인지, 옵셔널인지
9. **Concurrency 고려**: parallel 의 event order 정책
10. **Property-based testing**: fast-check 기반 laws 제공 여부

---

## 추가 컨텍스트 (요청자)

- StateT 의뢰 때와 동일한 프로젝트 (presence — Free Monad 기반 에이전트 플랫폼)
- 실제 use case 4개 (session / approve / connection / delegate FSM) 가 대기 중
- fun-fp-js 완성 전에 프로젝트 자체 PoC 로 병행 구현 예정 → **블로킹 없음**
- API 확정 후 PoC → fun-fp-js 로 swap 할 계획

피드백 / 의견 / 대안 제시 모두 환영합니다. 여러 라운드 논의 후 수렴하면 좋겠습니다.
