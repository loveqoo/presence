# Op ADT / 인터프리터 계층 정책

## 목적

presence의 Free Monad 기반 에이전트 실행 모델에서 Op ADT의 설계 규칙과 인터프리터 계층의 책임 경계를 정의한다. 순수한 프로그램 선언과 부작용을 가진 실행이 철저히 분리되어야 한다.

## 불변식 (Invariants)

- I1. **Op의 map은 continuation에만 적용**: `makeOp(tag)(data, next)`에서 `map(f)`는 `next`에만 `f`를 합성한다. `data` 필드를 변경하지 않는다. 이것이 Free Monad의 Functor 법칙 준수 기반.
- I2. **DSL 함수는 Free.liftF로 Op을 래핑**: `askLLM(...)`, `executeTool(...)` 등 DSL 함수는 Op을 `Free.liftF(Op(...))` 로 감싸서 반환한다. 인터프리터가 효과를 실행하기 전까지 Op은 순수 데이터.
- I3. **인터프리터 시그니처**: 모든 인터프리터 핸들러는 `(op) => StateT(Task)([nextFree, newState])` 형태. Op 효과 실행 후 `op.next(result)`로 다음 Free 스텝을 반환.
- I4. **Interpreter 클래스 + handles Set**: 각 단일 관심사 인터프리터는 `Interpreter` 인스턴스로 캡슐화. `handles: Set<tag>`으로 담당 Op을 선언. `Interpreter.compose()`가 tag 기반으로 dispatch.
- I5. **중복 태그 즉시 fail-fast**: 동일 태그를 두 `Interpreter` 인스턴스에 등록하면 `Interpreter.compose()`가 즉시 에러를 throw한다. 묵묵히 덮어쓰지 않는다.
- I6. **미처리 태그는 Task.rejected**: dispatch 테이블에 없는 태그의 Op은 `ST.lift(Task.rejected(new Error('Unknown op: ...')))` 반환.
- I7. **인터프리터 내부에서 ReactiveState 직접 참조 금지**: `prod.js`의 `createUiHelpers`가 유일한 예외. 그 외 인터프리터 핸들러는 StateT.get/modify로만 상태 접근.
- I8. **Reader 기반 인터프리터 팩토리**: 신규 인터프리터 팩토리는 `Reader.asks(deps => new Interpreter(...))` 형태로만 작성한다. 클로저 DI(`const createX = (deps) => { ... }`) 신규 작성 금지. 단, `const createX = (deps) => xR.run(deps)` 형태의 단일 라인 위임 브릿지는 레거시 호환을 위해 허용된다 (실제 예: `createJobTools`, `createSchedulerActor`). 브릿지는 Reader를 직접 노출하지 않는 소비처를 위한 어댑터이며, 내부 로직을 포함해서는 안 된다. **추가 예외: 기존 인터프리터를 래핑하는 상위 레이어(예: `tracedInterpreterR`)는 `Reader.asks(deps => { ... return { interpret, ST, getTrace, resetTrace } })` 형태로 `Interpreter` 인스턴스가 아닌 래퍼 shape을 반환할 수 있다. 새 기본 인터프리터는 `new Interpreter(...)` 반환 규칙을 따라야 한다.** traced는 상위 래퍼 — 하위 인터프리터 합성(`Interpreter.compose`) 결과를 `interpret` dep으로 주입받아 감싼다. `compose()`에는 직접 전달 불가.
- I9. **7개 인터프리터 합성 (prod)**: `stateInterpreter`, `llmInterpreter`, `toolInterpreter`, `delegateInterpreter`, `approvalInterpreter`, `controlInterpreter`, `parallelInterpreter` — 각각 단일 관심사. `delegateInterpreter`는 `packages/infra/src/interpreter/delegate.js`에 위치 (agentRegistry 의존 때문에 core가 아닌 infra 레벨).
- I10. **Parallel 브랜치 UI 억제**: `prod.js`의 `runProgram` 함수가 브랜치 실행 전후에 `ui.suppress()` / `ui.restore()`를 호출하여 UI 업데이트를 억제·복원한다 (`prod.js:61-68`). `parallelInterpreterR`은 `runProgram`을 주입받아 브랜치를 실행하며, suppress/restore에 직접 관여하지 않는다.
- I11. **traced 인터프리터는 Writer 기반**: `tracedInterpreter`는 `Writer.tell([entry])`로 trace를 축적. 가변 배열 push 금지. Trace 누적은 모듈/클로저 레벨 `let traceWriter`에 대한 재할당 체인(`traceWriter = traceWriter.chain(...)`)으로 이루어지며, 같은 `tracedInterpreterR` 인스턴스 내 모든 호출이 공유한다. 새 측정 시작 전에는 반드시 `resetTrace()`를 호출해 `Writer.of(null)`로 초기화해야 한다. 호출하지 않으면 이전 턴의 trace가 누적된 채로 `getTrace()`에 반환된다.
- I12. **Free 프로그램은 재실행 가능**: 같은 Free 프로그램 인스턴스에 다른 인터프리터를 적용하면 다른 효과가 실행된다 (dry-run, traced 등).

## Op 목록

| Op | 태그 | 담당 인터프리터 | 설명 |
|----|------|----------------|------|
| `AskLLM` | `AskLLM` | llmInterpreter | LLM 호출 |
| `ExecuteTool` | `ExecuteTool` | toolInterpreter | 도구 실행 |
| `Respond` | `Respond` | controlInterpreter | 사용자 응답 |
| `Approve` | `Approve` | approvalInterpreter | 사용자 승인 요청 |
| `Delegate` | `Delegate` | delegateInterpreter | 에이전트 위임 |
| `Observe` | `Observe` | controlInterpreter | 결과 관찰 기록 |
| `UpdateState` | `UpdateState` | stateInterpreter | State 변경 |
| `GetState` | `GetState` | stateInterpreter | State 조회 |
| `Parallel` | `Parallel` | parallelInterpreter | 병렬 실행 |
| `Spawn` | `Spawn` | controlInterpreter | 백그라운드 실행 (현재 no-op: `ST.of(f.next(undefined))`) |

## 경계 조건 (Edge Cases)

- E1. `askLLM({ messages: "string" })` — messages가 배열 아닌 경우 → `TypeError: messages must be an array` 즉시 throw.
- E2. 알려지지 않은 Op 태그 → `Interpreter.compose` dispatch 실패 → `Task.rejected(new Error('Unknown op: ...'))`.
- E3. `Parallel` 내 브랜치 중 하나 실패 → `Promise.allSettled` 사용으로 나머지 브랜치 계속 실행. 실패 브랜치 결과는 에러로 수집.
- E4. `Approve` Op에서 사용자가 취소 → `handleCancel()` 호출 → TurnController가 abort 신호 전송.
- E5. `Delegate` 대상 에이전트가 없는 경우 → `agentRegistry.get(name)` null → 즉시 에러.
- E6. 인터프리터 합성 후 `interpret(op)`에 null/undefined op → dispatch 시 `op.tag` 접근 에러.
- E7. StateT.get()으로 존재하지 않는 경로 접근 → `undefined` 반환. null/undefined 방어 필요.
- E9. `dryrun`: state 효과 없음 (`UpdateState`/`GetState` 모두 stub — 플랜/계획 흐름 관찰 전용). `test`: `stateInterpreterR` 포함 → state 실제 작동 (핸들러 출력 assert 가능).
- E10. AskLLM tool_calls 요청 시 스트리밍 비활성화 (비스트리밍 폴백). abort signal은 `getAbortSignal` dep으로 주입되어 턴 abort 시 LLM 호출 중단. 스트리밍 조건: `streamingUi.isEnabled() && !f.tools && llm.chatStream` 세 조건 모두 참.
- E8. LLM 타임아웃 초과 → `llmInterpreter`가 Task.rejected → `Executor.recover()`가 state에 `TurnOutcome.failure` 플래그를 기록하고 throw. **재시도 없음** (`executor.js:83-93`). 별도로, Planner의 JSON parse 실패 시에는 `executeCycle(turn, n, retriesLeft)` 파라미터로 재시도하는 독립된 메커니즘이 존재한다 — LLM 타임아웃과 다른 경로.

## 테스트 커버리지

- I1 → `packages/core/test/core/make-op.test.js` (Functor 법칙, map continuation 적용)
- I1, I12 → `packages/core/test/core/fp-laws.test.js` (Free Monad 법칙)
- I3, I4 → `packages/core/test/interpreter/prod.test.js`
- I5 → `packages/core/test/interpreter/prod.test.js` (중복 태그 throw)
- I6 → `packages/core/test/interpreter/prod.test.js` (미처리 태그 rejected)
- I7 → (미커버) ⚠️ 인터프리터 내 ReactiveState 접근 자동 금지 없음
- I10 → `packages/core/test/interpreter/parallel.test.js` (ref-count UI 억제)
- I11 → `packages/core/test/interpreter/traced.test.js` (Writer trace 축적)
- E1 → `packages/core/test/core/op.test.js` (askLLM messages 타입 검증)
- E3 → `packages/core/test/interpreter/parallel.test.js` (브랜치 실패 격리)

## 관련 코드

- `packages/core/src/core/op.js` — Op ADT 정의 + DSL 함수
- `packages/core/src/interpreter/compose.js` — Interpreter 클래스 + compose
- `packages/core/src/interpreter/state.js` — StateOp 인터프리터
- `packages/core/src/interpreter/llm.js` — LLM Op 인터프리터 (core 레벨 — 실제 LLM 없음)
- `packages/core/src/interpreter/tool.js` — Tool Op 인터프리터
- `packages/core/src/interpreter/control.js` — Respond, Observe, Spawn Op (Spawn은 현재 no-op)
- `packages/core/src/interpreter/approval.js` — Approve Op
- `packages/core/src/interpreter/parallel.js` — Parallel Op
- `packages/core/src/interpreter/traced.js` — Writer 기반 trace 래퍼
- `packages/core/src/interpreter/dryrun.js` — Dry-run 인터프리터
- `packages/core/src/interpreter/test.js` — 테스트용 인터프리터
- `packages/infra/src/interpreter/prod.js` — 프로덕션 인터프리터 (7개 합성)
- `packages/infra/src/interpreter/delegate.js` — Delegate 인터프리터 (infra 레벨 — agentRegistry 의존)
- `packages/core/src/lib/fun-fp.js` — Free, StateT, Task, Writer 구현

## 변경 이력

- 2026-04-10: 초기 작성
- 2026-04-10: I9에 delegateInterpreter 위치 명시, 관련 코드에 test.js/delegate.js 추가
- 2026-04-10: I8 레거시 브릿지 경계 명시 — 단일 라인 위임(createJobTools, createSchedulerActor 형태)은 허용, 신규 팩토리는 Reader.asks 전용
- 2026-04-10: Op 테이블 Spawn 담당 인터프리터 정정 — parallelInterpreter → controlInterpreter (control.js:8 실제 handles 배열 기준). I10 suppress/restore 담당 정정 — parallelInterpreterR이 아닌 prod.js runProgram이 담당. 관련 코드 섹션 parallel.js/control.js 설명 갱신.
- 2026-04-10: I8 traced 인터프리터 예외 추가 — tracedInterpreterR은 Reader.asks 형태이나 반환이 Interpreter 인스턴스가 아닌 래퍼 shape `{ interpret, ST, getTrace, resetTrace }`. 기존 인터프리터 래핑 레이어에 한해 허용.
- 2026-04-10: I11 사용 전제조건 추가 — traceWriter가 클로저 레벨 let으로 재할당 누적되며 호출자 간 공유됨. 새 측정 전 resetTrace() 호출 필수.
- 2026-04-10: E8 정정 — "Executor 재시도" 오기 제거. Executor.recover()는 실패 state 기록 후 throw만 수행(재시도 없음). Planner parse 실패 재시도는 별도 메커니즘임을 분리 명시.
- 2026-04-10: I8에 traced 소비 패턴 명시 — compose() 결과를 interpret dep으로 주입받아 감싸는 상위 래퍼 패턴. E9 추가 — dryrun vs test 인터프리터 state 작동 차이. E10 추가 — AskLLM 스트리밍 3조건 및 abort 전파.
