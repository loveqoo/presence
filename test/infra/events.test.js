import {
  withEventMeta, eventToPrompt, todoFromEvent, isDuplicate,
} from '../../src/infra/events.js'
import {
  createEventActor, createEmit, applyTodo, forkTask, createTurnActor,
} from '../../src/infra/actors.js'
import fp from '../../src/lib/fun-fp.js'
const { Maybe } = fp
import { createReactiveState } from '../../src/infra/state.js'
import { Phase } from '../../src/core/agent.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

async function run() {
  console.log('Event system tests')

  // ===========================================
  // createEmit (EventActor 경유 fire-and-forget)
  // ===========================================

  // emit → EventActor enqueue → projection 반영
  {
    const state = createReactiveState({
      turnState: Phase.working('busy'),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })
    const turnActor = createTurnActor(async () => 'done')
    const eventActor = createEventActor({ turnActor, state, logger: null })
    const emit = createEmit(eventActor)

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
    const state = createReactiveState({
      turnState: Phase.working('busy'),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })
    const turnActor = createTurnActor(async () => 'done')
    const eventActor = createEventActor({ turnActor, state, logger: null })
    const emit = createEmit(eventActor)

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
    const state = createReactiveState({
      turnState: Phase.working('busy'),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })
    const turnActor = createTurnActor(async () => 'done')
    const eventActor = createEventActor({ turnActor, state, logger: null })
    const emit = createEmit(eventActor)
    const event = emit({ type: 'x', id: 'custom-id' })
    assert(event.id === 'custom-id', 'emit custom id: preserved')
  }

  // ===========================================
  // EventActor: enqueue + drain
  // ===========================================

  // idle 상태에서 enqueue → 자동 drain → turnActor 호출
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })

    let runCalled = false
    let runInput = null
    const turnActor = createTurnActor(async (input) => {
      runCalled = true
      runInput = input
      return 'done'
    })
    const eventActor = createEventActor({ turnActor, state, logger: null })

    const enriched = withEventMeta({ type: 'heartbeat', prompt: '점검' })
    await forkTask(eventActor.send({ type: 'enqueue', event: enriched }))
    await new Promise(r => setTimeout(r, 100))

    assert(runCalled, 'EventActor: turnActor called')
    assert(runInput === '점검', 'EventActor: correct prompt')
    assert(state.get('events.queue').length === 0, 'EventActor: queue drained')
    assert(state.get('events.lastProcessed').type === 'heartbeat', 'EventActor: lastProcessed set')
  }

  // working 상태에서 enqueue → drain no-op (큐에 남음)
  {
    const state = createReactiveState({
      turnState: Phase.working('busy'),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })

    const turnActor = createTurnActor(async () => 'done')
    const eventActor = createEventActor({ turnActor, state, logger: null })

    const enriched = withEventMeta({ type: 'test' })
    await forkTask(eventActor.send({ type: 'enqueue', event: enriched }))
    await new Promise(r => setTimeout(r, 50))

    assert(state.get('events.queue').length === 1, 'busy agent: event stays in queue')
  }

  // turnActor 실패 → deadLetter
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })

    const turnActor = createTurnActor(async () => { throw new Error('agent crash') })
    const eventActor = createEventActor({ turnActor, state, logger: null })

    const enriched = withEventMeta({ type: 'bad' })
    await forkTask(eventActor.send({ type: 'enqueue', event: enriched }))
    await new Promise(r => setTimeout(r, 100))

    assert(state.get('events.queue').length === 0, 'failed event: removed from queue')
    const dl = state.get('events.deadLetter')
    assert(dl.length === 1, 'failed event: added to deadLetter')
    assert(dl[0].error === 'agent crash', 'failed event: error recorded')
    assert(typeof dl[0].failedAt === 'number', 'failed event: failedAt set')
  }

  // enqueue 3개 + drain → 순차 처리
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })

    const processed = []
    const turnActor = createTurnActor(async (input) => {
      processed.push(input)
      return 'done'
    })
    const eventActor = createEventActor({ turnActor, state, logger: null })

    // 3개 enqueue (idle이므로 첫 enqueue에서 자동 drain)
    await forkTask(eventActor.send({ type: 'enqueue', event: withEventMeta({ type: 'a', prompt: 'first' }) }))
    await forkTask(eventActor.send({ type: 'enqueue', event: withEventMeta({ type: 'b', prompt: 'second' }) }))
    await forkTask(eventActor.send({ type: 'enqueue', event: withEventMeta({ type: 'c', prompt: 'third' }) }))

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
    const state = createReactiveState({
      turnState: Phase.idle(),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })
    const turnActor = createTurnActor(async () => 'done')
    const eventActor = createEventActor({ turnActor, state, logger: null })

    const result = await forkTask(eventActor.send({ type: 'drain' }))
    assert(result === 'no-op:empty', 'drain idempotency: empty queue → no-op')
  }

  // drain idempotency: not-idle → no-op
  {
    const state = createReactiveState({
      turnState: Phase.working('busy'),
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
    })
    const turnActor = createTurnActor(async () => 'done')
    const eventActor = createEventActor({ turnActor, state, logger: null })

    // enqueue 후 drain 시도 (working이므로 no-op)
    await forkTask(eventActor.send({ type: 'enqueue', event: withEventMeta({ type: 'x' }) }))
    const result = await forkTask(eventActor.send({ type: 'drain' }))
    assert(result === 'no-op:busy', 'drain idempotency: not-idle → no-op')
  }

  // ===========================================
  // applyTodo (순수 함수)
  // ===========================================

  // 이벤트에 todo 필드 → TODO 생성
  {
    const state = createReactiveState({ todos: [] })
    applyTodo(state, {
      id: 'evt-1',
      type: 'pr_assigned',
      todo: { type: 'pr_review', title: 'Review PR #42', data: { url: '/pr/42' } },
    })

    const todos = state.get('todos')
    assert(todos.length === 1, 'applyTodo: 1 todo')
    assert(todos[0].type === 'pr_review', 'applyTodo: correct type')
    assert(todos[0].sourceEventId === 'evt-1', 'applyTodo: sourceEventId')
    assert(todos[0].done === false, 'applyTodo: not done')
  }

  // todo 필드 없는 이벤트 → TODO 미생성
  {
    const state = createReactiveState({ todos: [] })
    applyTodo(state, { id: 'evt-2', type: 'heartbeat' })
    assert(state.get('todos').length === 0, 'applyTodo no todo: no todo created')
  }

  // 멱등성: 같은 이벤트 재처리 → TODO 중복 없음
  {
    const state = createReactiveState({ todos: [] })
    const event = { id: 'evt-dup', type: 'issue', todo: { type: 'issue_review', title: 'Check issue' } }
    applyTodo(state, event)
    applyTodo(state, event) // 재처리
    assert(state.get('todos').length === 1, 'applyTodo idempotent: no duplicate')
  }

  // EventActor drain 성공 → applyTodo 자동 호출
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      events: { queue: [], inFlight: null, lastProcessed: null, deadLetter: [] },
      todos: [],
    })
    const turnActor = createTurnActor(async () => 'done')
    const eventActor = createEventActor({ turnActor, state, logger: null })

    const enriched = withEventMeta({
      type: 'pr_assigned',
      todo: { type: 'pr_review', title: 'Review PR' },
    })
    await forkTask(eventActor.send({ type: 'enqueue', event: enriched }))
    await new Promise(r => setTimeout(r, 150))

    const todos = state.get('todos')
    assert(todos.length === 1, 'EventActor + TODO: todo created after drain')
    assert(todos[0].type === 'pr_review', 'EventActor + TODO: correct type')
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
    assert(r1.value.sourceEventId === 'e1', 'todoFromEvent: sourceEventId')
    assert(r1.value.type === 'review', 'todoFromEvent: todo type')
    assert(r1.value.done === false, 'todoFromEvent: done is false')
  }
  {
    assert(todoFromEvent({ id: 'e2', type: 'heartbeat' }).isNothing(), 'todoFromEvent no todo: Nothing')
    assert(todoFromEvent({ id: 'e3', todo: null }).isNothing(), 'todoFromEvent null todo: Nothing')
    assert(todoFromEvent({ id: 'e4', todo: undefined }).isNothing(), 'todoFromEvent undefined: Nothing')
  }
  {
    const r = todoFromEvent({ id: 'e5', type: 'x', todo: {} })
    assert(r.isJust(), 'todoFromEvent empty todo: Just (defaults applied)')
    assert(r.value.type === 'x', 'todoFromEvent: falls back to event.type')
    assert(r.value.title === 'x', 'todoFromEvent: title falls back to event.type')
  }

  // isDuplicate
  {
    const todos = [{ sourceEventId: 'e1' }, { sourceEventId: 'e2' }]
    assert(isDuplicate(todos, 'e1') === true, 'isDuplicate: found')
    assert(isDuplicate(todos, 'e3') === false, 'isDuplicate: not found')
    assert(isDuplicate([], 'e1') === false, 'isDuplicate: empty list')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
