# Todo/State 관리 정책

## 목적

presence의 Todo 항목 관리, State 구조, 이벤트 흐름을 정의한다. Todo는 세션 state에 하드코딩되지 않고 UserDataStore에 저장되며, state.todos는 읽기 전용 projection이다. 이 영역은 현재 리팩토링이 진행 중인 상태이다.

## 현재 상태 (2026-04-10)

- Todo 데이터는 `UserDataStore`(SQLite)에 저장된다.
- `state.todos`는 UserDataStore의 projection(읽기 전용 미러)이다.
- `syncTodosProjection(state, userDataStore)` 함수가 store → state 동기화를 수행한다.
- 동기화 시점: UserSession 초기화(`restoreState`) + Todo write 직후.

## State 구조

세션 state (`OriginState`)의 최상위 필드:

```javascript
{
  turnState: TurnState.idle() | TurnState.working(input),
  lastTurn: TurnOutcome | null,
  turn: number,
  context: {
    memories: [],
    conversationHistory: []
  },
  events: {
    queue: [],
    inFlight: null,
    lastProcessed: null,
    deadLetter: []
  },
  delegates: { pending: [] },
  todos: [],      // UserDataStore projection (읽기 전용)

  // transient fields (저장 안 함, _접두사)
  _approve: ...,
  _budgetWarning: ...,
  _compactionEpoch: ...,
  _streaming: ...,
  _toolResults: ...,
  _debug: { lastTurn, lastPrompt, lastResponse, opTrace, recalledMemories, iterationHistory }
}
```

## 불변식 (Invariants)

- I1. **Todo 단일 저장소**: Todo 항목의 진원은 `UserDataStore`이다. `state.todos`는 캐시/projection이며 직접 쓰지 않는다. *(state.todos 구조 유지 기간 한정)*
- I2. **state.todos는 읽기 전용 projection**: `state.set('todos', ...)` 호출은 `syncTodosProjection()`과 초기화(`restoreState`)에서만 허용. 에이전트 프로그램(Op)에서 `updateState('todos', ...)`로 직접 쓰기 금지. *(state.todos 구조 유지 기간 한정)*
- I3. **Todo category/status 상수화**: Todo는 category=`TODO.CATEGORY` ('todo'), status=`TODO.STATUS_READY` ('ready')로만 생성. `policies.js`의 `TODO` 상수 사용.
- I4. **이벤트 → Todo 변환**: 외부 이벤트의 `.todo` 필드가 있으면 `todoFromEvent()`로 변환 후 `userDataStore.add()`. 변환 후 `syncTodosProjection()`으로 state 동기화. **단, 이 처리는 `enqueue()` 시점이 아니라 TurnActor drain 성공 후 `#handleDrainSuccess()` 내부에서 `#applyTodo()`를 통해 수행된다. drain 실패 시(`#handleDrainFailure()`)에는 Todo가 반영되지 않는다. drain 실패 후에도 큐에 잔여 이벤트가 있으면 다음 drain을 계속 시작한다 — 실패는 개별 이벤트 단위로 격리되며 큐 전체가 멈추지 않는다.**
- I5. **중복 Todo 방지**: `isDuplicate(existing, event.id)` — `withEventMeta()`가 부여한 이벤트 최상위 `id`로 중복 체크. `payload.sourceEventId` 아님. 같은 이벤트로 Todo 중복 생성 없음. (`event-actor.js:101`)
- I6. **State 변경은 `OriginState.set(path, value)`로**: 인터프리터 내 state 변경은 `StateT.modify` 또는 `UpdateState` Op으로만. 직접 변이 없음.
- I7. **_debug 이터레이션 이력 상한**: `_debug.iterationHistory`는 최대 10개(`DEBUG.MAX_ITERATION_HISTORY`). `slice(-10)` 적용.
- I8. **대화 이력 상한**: `context.conversationHistory`는 최대 20개(`HISTORY.MAX_CONVERSATION`). compaction 임계값 15개(`HISTORY.COMPACTION_THRESHOLD`). 압축 후 최소 보존 5개(`HISTORY.COMPACTION_KEEP`). `TurnLifecycle.finish()`는 `turn.source === TURN_SOURCE.USER`일 때만 conversationHistory에 기록한다. `TURN_SOURCE.EVENT` 소스 턴은 conversationHistory에 기록되지 않는다 (`planner.js:27-42`).
- I9. **compaction epoch 정합성**: compaction 결과 적용 시 현재 `_compactionEpoch`가 result의 `epoch`와 같을 때만 반영. epoch 불일치 시 결과 버림.
- I10. **Todo read_todos 툴**: UserSession이 `read_todos` 도구를 `toolRegistry`에 등록. 도구 핸들러에서 `context.userDataStore`로 직접 조회. state.todos를 경유하지 않음.
- I11. **Todo review 시스템 잡**: `scheduler.todoReview.enabled = true`이고 기존 잡이 없을 때 `SYSTEM_JOBS.TODO_REVIEW` (값: `'__todo_review__'`) 잡을 자동 등록. cron은 설정 기반. (`infra/constants.js`, 사용처: `user-session.js:97`)

## 이벤트 흐름

```
외부 이벤트 (webhook, scheduler, A2A)
  → EventActor.enqueue(event)
    → withEventMeta() (id, receivedAt 부여)
    → 큐에 적재, idle 상태면 drain 즉시 시작
  → EventActor.drain()
    → eventToPrompt(event)로 에이전트 입력 생성
    → TurnActor.run() 실행
      → [성공] #handleDrainSuccess()
          → #applyTodo(): todoFromEvent() → UserDataStore.add() + syncTodosProjection()
          → 다음 drain 시작 (큐에 잔여 이벤트 있으면)
      → [실패] #handleDrainFailure()
          → deadLetter에 이벤트 적재. Todo 반영 없음.
          → 큐에 잔여 이벤트가 있으면 다음 drain 계속 시작 (실패는 개별 이벤트 단위로 격리. 큐 전체가 멈추지 않음)
```

## 경계 조건 (Edge Cases)

- E1. `state.todos`에서 직접 읽으면 UserDataStore와 불일치 가능 → 반드시 `syncTodosProjection()` 후 읽거나, `userDataStore.list()`로 직접 조회.
- E2. 이벤트에 `.todo` 필드가 없는 경우 → `todoFromEvent()` `Maybe.Nothing()` 반환 → Todo 생성 없음.
- E3. 같은 eventId로 두 번 이벤트 처리 → `isDuplicate()` 체크 → 두 번째는 Todo 미생성.
- E4. `SYSTEM_JOBS.TODO_REVIEW` 잡이 이미 있는 상태에서 UserSession 재초기화 → `exists` 체크 후 skip. 중복 생성 없음.
- E5. `context.conversationHistory`가 compaction 임계값 이전 항목 포함 → compaction 결과에서 extractedIds로 제거 후 summary 삽입.
- E6. epoch 불일치로 compaction 결과 버려진 경우 → 대화 이력 압축 없음. 다음 턴에서 다시 compaction 시도.
- E7. `_debug.iterationHistory`가 10개 초과 → `slice(-10)`으로 최신 10개만 보존. 나머지 버림.
- E8. `updateState('todos', newTodos)` Op을 에이전트 프로그램이 실행하는 경우 → state는 변경되지만 UserDataStore에 반영 안 됨. 다음 `syncTodosProjection()` 호출 시 원상 복구됨. I2 위반.
- E9. EventActor의 deadLetter에 쌓인 이벤트 → 자동 재처리 없음. 수동 개입 또는 `/status` 확인 필요.

## 테스트 커버리지

- I1, I2 → `packages/infra/test/session.test.js` (Todo UserDataStore 기반 검증)
- I4, I5 → `packages/infra/test/events.test.js` (todoFromEvent, isDuplicate)
- I8 → `packages/core/test/core/compaction.test.js`
- I9 → `packages/infra/test/actors.test.js` (compaction epoch 정합성)
- I10 → `packages/infra/test/session.test.js` (read_todos 도구)
- I11 → `packages/infra/test/session.test.js` (todo_review 잡 자동 등록)
- E3 → `packages/infra/test/events.test.js` (isDuplicate)
- E8 → (미커버) ⚠️ 에이전트가 updateState('todos') Op 실행 시 불일치 시나리오 없음
- E9 → (미커버) ⚠️ deadLetter 처리 정책 미정의

## 관련 코드

- `packages/core/src/core/policies.js` — TODO, STATE_PATH, HISTORY, DEBUG 상수
- `packages/infra/src/infra/events.js` — todoFromEvent, isDuplicate, syncTodosProjection, eventToPrompt
- `packages/infra/src/infra/user-data-store.js` — UserDataStore (Todo 저장소)
- `packages/infra/src/infra/sessions/user-session.js` — restoreState(syncTodosProjection), initTools(read_todos, todo_review 잡)
- `packages/infra/src/infra/sessions/internal/session-actors.js` — SessionActors (compaction 구독)
- `packages/infra/src/infra/actors/compaction-actor.js` — 대화 이력 압축, epoch 정합성
- `packages/infra/src/infra/actors/event-actor.js` — 이벤트 큐, deadLetter
- `packages/infra/src/infra/states/origin-state.js` — OriginState (state 변경 + publish)

## 전환 중인 영역

현재 Todo는 `state.todos`와 `UserDataStore` 두 곳에 동시 존재한다. `state.todos`가 projection임을 명확히 하여 혼동을 방지하고 있으나, 에이전트가 `UpdateState` Op으로 `state.todos`를 직접 조작하는 경우에 대한 방어가 완전하지 않다. (E8 참조)

향후 작업: state.todos를 완전히 제거하고 모든 Todo 접근을 `userDataStore`로 단일화 예정 (MEMORY.md `project_todo_store.md` 참조).

**전환 중 불변식 유효 범위**: I1, I2, E1, E8 등 `state.todos`를 언급하는 불변식과 경계 조건은 `state.todos` 필드가 세션 state에 존재하는 동안만 유효하다. `state.todos` 제거 후에는 해당 항목이 무효화되며, 대체 불변식은 TBD다. 제거 완료 시 이 스펙의 관련 항목을 일괄 삭제하거나 재작성해야 한다.

## 변경 이력

- 2026-04-10: 초기 작성 — Todo UserDataStore 분리 완료 시점 기준
- 2026-04-10: I1/I2에 "(state.todos 유지 기간 한정)" 주석 추가, 전환 중 영역에 유효 기간 명시 — state.todos 제거 후 불변식 TBD
- 2026-04-10: I11, E4의 `__todo_review__` 매직 스트링 → `SYSTEM_JOBS.TODO_REVIEW` 상수 참조로 교체. 상수 위치(constants.js)와 사용처(user-session.js:97) 명시.
- 2026-04-10: I4 및 이벤트 흐름 다이어그램 정정 — Todo 반영은 enqueue 시점이 아닌 drain 성공 후 `#handleDrainSuccess()` → `#applyTodo()`에서 수행됨. 실패 시 Todo 미반영 명시.
- 2026-04-10: I5 정정 — isDuplicate 인자가 payload.sourceEventId가 아닌 withEventMeta()가 부여한 event.id임을 정정 (event-actor.js:101 기준).
- 2026-04-10: I4 및 이벤트 흐름 다이어그램 보강 — drain 실패 후에도 큐 잔여 이벤트가 있으면 다음 drain 계속. 실패는 개별 이벤트 단위 격리, 큐 전체 정지 없음 명시.
- 2026-04-10: I8에 TURN_SOURCE.EVENT 대화이력 제외 정책 추가 — TurnLifecycle.finish()가 USER 소스만 conversationHistory에 기록함을 명시.
