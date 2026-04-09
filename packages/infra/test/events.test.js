import {
  withEventMeta, eventToPrompt, todoFromEvent, isDuplicate,
} from '@presence/infra/infra/events.js'
import { EventActor, eventActorR } from '@presence/infra/infra/actors/event-actor.js'
import { turnActorR } from '@presence/infra/infra/actors/turn-actor.js'
import { forkTask } from '@presence/core/lib/task.js'
import fp from '@presence/core/lib/fun-fp.js'
const { Maybe } = fp
import { createOriginState } from '@presence/infra/infra/states/origin-state.js'
import { TurnState } from '@presence/core/core/policies.js'
import { assert, summary } from '../../../test/lib/assert.js'

// In-memory mock UserDataStore
const createMockUserDataStore = () => {
  const rows = []
  let nextId = 1
  return {
    list: ({ category, status } = {}) => rows
      .filter(r => (!category || r.category === category) && (!status || r.status === status))
      .map(r => ({ ...r, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload })),
    add: ({ category, status, title, payload }) => {
      const row = { id: nextId++, category, status, title, payload, createdAt: Date.now(), updatedAt: Date.now() }
      rows.push(row)
      return row
    },
    get: (id) => rows.find(r => r.id === id) || null,
    update: () => true,
    remove: () => true,
    close: () => {},
  }
}

async function run() {
  console.log('Event system tests')

  // ===========================================
  // createEmit (EventActor 경유 fire-and-forget)
  // ===========================================

  // emit → EventActor enqueue → projection 반영
  {
    const state = createOriginState({
      turnState: TurnState.working('busy'),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })
    const turnActor = turnActorR.run({ runTurn: async () => 'done' })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })
    const emit = (event) => eventActor.emit(event)

    const event = emit({ type: 'test', data: 'hello' })
    assert(event.id !== undefined, 'emit: assigns id')
    assert(event.receivedAt > 0, 'emit: assigns receivedAt')

    await new Promise(r => setTimeout(r, 30))
    const queue = state.get('events.queue')
    assert(queue.length === 1, 'emit: projected to state queue')
    assert(queue[0].type === 'test', 'emit: event type preserved')
  }

  // 연속 emit → 유실 없이 큐에 누적
  {
    const state = createOriginState({
      turnState: TurnState.working('busy'),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })
    const turnActor = turnActorR.run({ runTurn: async () => 'done' })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })
    const emit = (event) => eventActor.emit(event)

    emit({ type: 'a' })
    emit({ type: 'b' })
    emit({ type: 'c' })

    await new Promise(r => setTimeout(r, 50))
    const queue = state.get('events.queue')
    assert(queue.length === 3, 'sequential emit: 3 events queued')
    assert(queue[0].type === 'a', 'sequential emit: order preserved (first)')
    assert(queue[2].type === 'c', 'sequential emit: order preserved (last)')
  }

  // emit with custom id → 그대로 유지
  {
    const state = createOriginState({
      turnState: TurnState.working('busy'),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })
    const turnActor = turnActorR.run({ runTurn: async () => 'done' })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })
    const emit = (event) => eventActor.emit(event)
    const event = emit({ type: 'x', id: 'custom-id' })
    assert(event.id === 'custom-id', 'emit custom id: preserved')
  }

  // ===========================================
  // EventActor: enqueue + drain
  // ===========================================

  // idle 상태에서 enqueue → 자동 drain → turnActor 호출
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })

    let runCalled = false
    let runInput = null
    const turnActor = turnActorR.run({ runTurn: async (input) => {
      runCalled = true
      runInput = input
      return 'done'
    } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    const enriched = withEventMeta({ type: 'heartbeat', prompt: '점검' })
    await forkTask(eventActor.enqueue(enriched))
    await new Promise(r => setTimeout(r, 100))

    assert(runCalled, 'EventActor: turnActor called')
    assert(runInput === '점검', 'EventActor: correct prompt')
    assert(state.get('events.queue').length === 0, 'EventActor: queue drained')
    assert(state.get('events.lastProcessed').type === 'heartbeat', 'EventActor: lastProcessed set')
  }

  // working 상태에서 enqueue → drain no-op (큐에 남음)
  {
    const state = createOriginState({
      turnState: TurnState.working('busy'),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })

    const turnActor = turnActorR.run({ runTurn: async () => 'done' })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    const enriched = withEventMeta({ type: 'test' })
    await forkTask(eventActor.enqueue(enriched))
    await new Promise(r => setTimeout(r, 50))

    assert(state.get('events.queue').length === 1, 'busy agent: event stays in queue')
  }

  // turnActor 실패 → deadLetter
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })

    const turnActor = turnActorR.run({ runTurn: async () => { throw new Error('agent crash') } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    const enriched = withEventMeta({ type: 'bad' })
    await forkTask(eventActor.enqueue(enriched))
    await new Promise(r => setTimeout(r, 100))

    assert(state.get('events.queue').length === 0, 'failed event: removed from queue')
    const dl = state.get('events.deadLetter')
    assert(dl.length === 1, 'failed event: added to deadLetter')
    assert(dl[0].error === 'agent crash', 'failed event: error recorded')
    assert(typeof dl[0].failedAt === 'number', 'failed event: failedAt set')
  }

  // enqueue 3개 + drain → 순차 처리
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })

    const processed = []
    const turnActor = turnActorR.run({ runTurn: async (input) => {
      processed.push(input)
      return 'done'
    } })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    // 3개 enqueue (idle이므로 첫 enqueue에서 자동 drain)
    await forkTask(eventActor.enqueue(withEventMeta({ type: 'a', prompt: 'first' })))
    await forkTask(eventActor.enqueue(withEventMeta({ type: 'b', prompt: 'second' })))
    await forkTask(eventActor.enqueue(withEventMeta({ type: 'c', prompt: 'third' })))

    // drain 완료 대기
    await new Promise(r => setTimeout(r, 300))

    assert(processed.length === 3, 'sequential: 3 events processed')
    assert(processed[0] === 'first', 'sequential: first processed first')
    assert(processed[1] === 'second', 'sequential: second processed second')
    assert(processed[2] === 'third', 'sequential: third processed third')
    assert(state.get('events.queue').length === 0, 'sequential: queue empty')
  }

  // drain idempotency: 큐 비었을 때 no-op
  {
    const state = createOriginState({
      turnState: TurnState.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })
    const turnActor = turnActorR.run({ runTurn: async () => 'done' })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    const result = await forkTask(eventActor.drain())
    assert(result === EventActor.RESULT.NO_OP_EMPTY, 'drain idempotency: empty queue → no-op')
  }

  // drain idempotency: not-idle → no-op
  {
    const state = createOriginState({
      turnState: TurnState.working('busy'),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })
    const turnActor = turnActorR.run({ runTurn: async () => 'done' })
    const eventActor = eventActorR.run({ turnActor, state, logger: null })

    // enqueue 후 drain 시도 (working이므로 no-op)
    await forkTask(eventActor.send({ type: 'enqueue', event: withEventMeta({ type: 'x' }) }))
    const result = await forkTask(eventActor.drain())
    assert(result === EventActor.RESULT.NO_OP_BUSY, 'drain idempotency: not-idle → no-op')
  }

  // EventActor drain 성공 → applyTodo → userDataStore에 저장 + state projection
  {
    const userDataStore = createMockUserDataStore()
    const state = createOriginState({
      turnState: TurnState.idle(),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    const turnActor = turnActorR.run({ runTurn: async () => 'done' })
    const eventActor = eventActorR.run({ turnActor, state, logger: null, userDataStore })

    const enriched = withEventMeta({
      type: 'pr_assigned',
      todo: { type: 'pr_review', title: 'Review PR' },
    })
    await forkTask(eventActor.enqueue(enriched))
    await new Promise(r => setTimeout(r, 150))

    // store에 저장됐는지
    const stored = userDataStore.list({ category: 'todo' })
    assert(stored.length === 1, 'EventActor + TODO: todo stored in userDataStore')
    assert(stored[0].payload.type === 'pr_review', 'EventActor + TODO: correct type in store')
    // state projection 동기화
    const projected = state.get('todos')
    assert(projected.length === 1, 'EventActor + TODO: projection synced to state')
  }

  // ===========================================
  // 순수 함수 단위 테스트
  // ===========================================

  // withEventMeta
  {
    const e = withEventMeta({ type: 'test', data: 'x' })
    assert(typeof e.id === 'string' && e.id.length > 0, 'withEventMeta: assigns id')
    assert(typeof e.receivedAt === 'number', 'withEventMeta: assigns receivedAt')
    assert(e.type === 'test', 'withEventMeta: preserves original fields')
  }
  {
    const e = withEventMeta({ type: 'x', id: 'custom-id' })
    assert(e.id === 'custom-id', 'withEventMeta: preserves existing id')
  }

  // eventToPrompt
  {
    assert(eventToPrompt({ prompt: '점검' }) === '점검', 'eventToPrompt: prompt field')
    assert(eventToPrompt({ message: '알림' }) === '알림', 'eventToPrompt: message fallback')
    assert(eventToPrompt({ type: 'heartbeat' }) === '이벤트 처리: heartbeat', 'eventToPrompt: type fallback')
    assert(eventToPrompt({ prompt: 'a', message: 'b' }) === 'a', 'eventToPrompt: prompt takes priority')
  }

  // todoFromEvent → Maybe
  {
    const r1 = todoFromEvent({ id: 'e1', type: 'pr', todo: { type: 'review', title: 'PR #1' } })
    assert(r1.isJust(), 'todoFromEvent with todo: Just')
    assert(r1.value.payload.sourceEventId === 'e1', 'todoFromEvent: sourceEventId in payload')
    assert(r1.value.payload.type === 'review', 'todoFromEvent: todo type in payload')
    assert(r1.value.status === 'ready', 'todoFromEvent: status is ready')
  }
  {
    assert(todoFromEvent({ id: 'e2', type: 'heartbeat' }).isNothing(), 'todoFromEvent no todo: Nothing')
    assert(todoFromEvent({ id: 'e3', todo: null }).isNothing(), 'todoFromEvent null todo: Nothing')
    assert(todoFromEvent({ id: 'e4', todo: undefined }).isNothing(), 'todoFromEvent undefined: Nothing')
  }
  {
    const r = todoFromEvent({ id: 'e5', type: 'x', todo: {} })
    assert(r.isJust(), 'todoFromEvent empty todo: Just (defaults applied)')
    assert(r.value.payload.type === 'x', 'todoFromEvent: falls back to event.type')
    assert(r.value.title === 'x', 'todoFromEvent: title falls back to event.type')
  }

  // isDuplicate
  {
    const todos = [{ payload: { sourceEventId: 'e1' } }, { payload: { sourceEventId: 'e2' } }]
    assert(isDuplicate(todos, 'e1') === true, 'isDuplicate: found')
    assert(isDuplicate(todos, 'e3') === false, 'isDuplicate: not found')
    assert(isDuplicate([], 'e1') === false, 'isDuplicate: empty list')
  }

  summary()
}

run()
