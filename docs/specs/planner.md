# Planner 정책

## 목적

에이전트 턴을 두 계층으로 분리하여 LLM의 관심사와 인터프리터의 관심사를 격리한다.
**Plan 계층**은 LLM이 JSON wire format으로 내보내는 실행 의도(Op 코드 목록)이고,
**Free 계층**은 인터프리터가 실제 효과를 실행하는 단위(Op ADT)다.
LLM은 플랜만 생성하고 실제 IO·상태 변경·에러 처리는 인터프리터 영역이기 때문에
계층이 두 개여야 한다: 하나로 합치면 LLM 출력 파싱 실패가 곧 부작용 실행 실패와 동치가 된다.
`Executor`는 이 두 계층 사이의 생명주기를 조율하는 조율자다.

## 불변식 (Invariants)

- I1. **두 계층 분리**: Plan Op(JSON wire)와 Free Op(ADT)는 서로 다른 표현이다.
  Plan Op 코드 문자열은 `op-handler.js`의 `ops` 테이블이 권위이고,
  Free Op는 `op.js`의 ADT 생성자가 권위다.
  변환은 `Planner.normalizeStep()` → `ops[step.op].execute()` 경로만 허용된다.
  Plan이 Free를 직접 생성하거나 인터프리터가 Plan을 읽는 역방향은 없다.

- I2. **Plan Op 목록 중앙화**: 유효한 Plan Op 코드는 `op-handler.js`의 `ops` 객체 키
  (`LOOKUP_MEMORY`, `ASK_LLM`, `EXEC`, `RESPOND`, `APPROVE`, `DELEGATE`)
  만 인정된다.
  `validatePlan`은 `ops[step.op]`가 없으면 `Either.Left`를 반환해 해당 플랜을 거부한다.

- I3. **EXEC 변환 규칙**: `normalizeStep`은 `EXEC` 단계에서 두 가지 특수 케이스를 변환한다.
  `EXEC(tool='delegate')` → `DELEGATE`, `EXEC(tool='approve')` → `APPROVE`.
  이 변환 이후에 일반 `ExecOp`로 처리되는 경로는 없다.
  즉, `delegate`·`approve` 이름의 MCP 도구가 존재해도 `EXEC`로 실행될 수 없다.

- I4. **Executor 의존성 계약**: `Executor`는 생성 시 `{ interpret, ST, state, actors }`를 받는다.
  `run(program, input)`은 이 의존성으로
  `beginLifecycle → recallMemories → runFreeWithStateT → afterTurn → persist` 순서를 수행한다.
  어떤 인터프리터를 쓰는지 Executor는 모른다: `interpret` 함수 하나만 받는다.

- I5. **실패 복구 원자성**: `recover(input, err)`는
  `STATE_PATH.STREAMING`, `STATE_PATH.LAST_TURN`, `STATE_PATH.TURN_STATE`
  세 경로를 하나의 for 루프에서 순차 set하고 즉시 persist한다.
  recover 완료 후 예외를 재전파한다. 재시도는 recover 책임이 아니다.

- I6. **`applyFinalState` epoch 가드**: 턴 완료 시 `MANAGED_PATHS`에 나열된 경로만
  ReactiveState로 커밋된다. `_compactionEpoch`가 턴 시작 시점 대비 변경된 경우
  `STATE_PATH.CONTEXT_CONVERSATION_HISTORY` 경로는 스킵된다.
  `MANAGED_PATHS` 순서는 `TURN_STATE`가 마지막으로 고정된다:
  idle 전이 시 hook이 발동되어 다음 턴이 시작될 수 있으므로
  그 시점에 `conversationHistory`·`lastTurn`이 이미 최신이어야 한다.

- I7. **비동기 부작용 분리**: memory save, compaction check, persistence는
  `fireAndForget`으로 실행되어 턴 완료 경로를 블로킹하지 않는다.
  실패해도 턴 결과에 영향을 주지 않는다.

- I8. **Planner 재시도 범위**: `Planner.executeCycle(turn, n, retriesLeft)`의
  재시도(`retryOrFail`)는 `safeJsonParse` 또는 `validatePlan` 실패(Either.Left)에만 발동된다.
  LLM 타임아웃·네트워크 오류는 `askLLM` Free Op가 예외를 throw하므로
  `runFreeWithStateT` 실행 스택에서 catch되어 `Executor.recover`로 이어진다.
  Planner 재시도가 아니다.

## 경계 조건 (Edge Cases)

- E1. **턴 중 `/clear` 실행**: `clearDebugState`가 `_compactionEpoch`를 증가시키면
  `applyFinalState`의 epoch 가드가 발동되어 해당 턴의 `conversationHistory`는
  ReactiveState에 커밋되지 않는다.
  turnState·lastTurn 등 다른 MANAGED_PATHS는 정상 커밋된다.

- E2. **미정의 Plan Op 코드**: `validatePlan`이 `ops` 테이블에 없는 op 코드를 거부한다.
  `retryOrFail`이 호출되고, `retriesLeft`가 소진되면
  `lifecycle.respondAndFail`로 에러 메시지를 내보내고 턴이 종료된다.

- E3. **`runFreeWithStateT` 중 throw**: `Executor.run`의 try-catch가 잡아
  `recover(input, err)`를 실행한 뒤 예외를 재전파한다.
  이 경우 `afterTurn`은 실행되지 않으므로 memory save·persist는 recover 내부의
  `persist()` 한 번만 발생한다.

- E4. **`afterTurn` 내 memory save 실패**: `postTurnMemory`는 `fireAndForget`으로 분리된다.
  Task 실패는 경고 로그가 없이 무시된다(fire-and-forget 계약).
  turnState·conversationHistory 커밋은 이미 완료된 상태다.

- E5. **`RESPOND`가 마지막 스텝이 아닌 플랜**: `validatePlan`이
  `RESPOND`가 steps 배열 마지막이 아님을 감지하면 `Either.Left`로 거부한다.
  재시도 카운트에 합산된다.

## Known Gap

### ~~KG-10: retry 시 `DebugRecorder.record()`에 동일 iteration index 전달~~ (RESOLVED 2026-04-12)

**해소 내용**:
- `DebugRecorder.record(turn, n, prompt, rawResponse, parsed, retryAttempt = 0)` — `retryAttempt` 파라미터 추가 (기본값 0)
- `retryOrFail()`에서 `retryAttempt = this.maxRetries - retriesLeft + 1`을 계산하여 전달
- `iterEntry`에 `retryAttempt` 필드 포함 — 동일 `n`의 retry 항목이 `retryAttempt`로 구분됨
- `iterations.js` 렌더러: key에 `retryAttempt` 포함하여 React key 중복 방지, 헤더에 `(retry N)` 태그 표시

## 테스트 커버리지

- I1, I2, I3 → `packages/core/test/core/plan.test.js`
- I4 → `packages/core/test/core/agent.test.js`, `packages/core/test/core/free-integration.test.js`
- I5 → `packages/core/test/core/agent.test.js` ("Executor.recover() 단위 테스트" 블록, 8 assertion — STREAMING/LAST_TURN/TURN_STATE 경로 set 및 persist 검증)
- I6 → `packages/core/test/core/apply-final-state.test.js`, `packages/core/test/core/turn-concurrency.test.js`
- I7 → `packages/core/test/core/agent.test.js`
- I8 → `packages/core/test/core/plan.test.js`, `packages/core/test/core/agent.test.js`
- E1 → `packages/core/test/core/turn-concurrency.test.js`, `packages/core/test/core/apply-final-state.test.js`
- E2, E5 → `packages/core/test/core/plan.test.js`
- E3 → `packages/core/test/core/agent.test.js` (미커버 가능성 있음) ⚠️
- E4 → (미커버) ⚠️

## 관련 코드

- `packages/core/src/core/op.js` — Free Op ADT 정의
- `packages/core/src/core/op-handler.js` — Plan Op 테이블, Op 클래스 계층
- `packages/core/src/core/validate.js` — `safeJsonParse`, `validatePlan`, `validateStep`
- `packages/core/src/core/planner.js` — `Planner`, `TurnLifecycle`, `DebugRecorder`
- `packages/core/src/core/executor.js` — `Executor` (의존성 계약, 생명주기 조율, recover)
- `packages/core/src/core/state-commit.js` — `applyFinalState`, `clearDebugState`, `MANAGED_PATHS`

## 변경 이력

- 2026-04-10: 초기 작성 — Plan/Free 계층 분리, Executor 계약, epoch 경합 방어 기술
- 2026-04-10: I5 테스트 커버리지 갱신 — agent.test.js에 Executor.recover() 단위 테스트 블록(8 assertion) 추가됨을 반영.
- 2026-04-12: KG-10 추가 — retryOrFail의 iterationHistory 중복 index 갭 등록
- 2026-04-12: KG-10 해소 — DebugRecorder.record()에 retryAttempt 파라미터 추가, iterations.js 렌더러 key/태그 갱신
