import {
  createEventReceiver, wireEventHooks, wireTodoHooks,
  withEventMeta, eventToPrompt, todoFromEvent, isDuplicate,
} from '../../src/infra/events.js'
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
  // createEventReceiver
  // ===========================================

  // emit → 큐에 추가
  {
    const state = createReactiveState({
      events: { queue: [], lastProcessed: null, deadLetter: [] },
    })
    const { emit } = createEventReceiver(state)

    const event = emit({ type: 'test', data: 'hello' })
    assert(event.id !== undefined, 'emit: assigns id')
    assert(event.receivedAt > 0, 'emit: assigns receivedAt')

    const queue = state.get('events.queue')
    assert(queue.length === 1, 'emit: appended to queue')
    assert(queue[0].type === 'test', 'emit: event type preserved')
  }

  // 연속 emit → 유실 없이 큐에 누적
  {
    const state = createReactiveState({
      events: { queue: [], lastProcessed: null, deadLetter: [] },
    })
    const { emit } = createEventReceiver(state)

    emit({ type: 'a' })
    emit({ type: 'b' })
    emit({ type: 'c' })

    const queue = state.get('events.queue')
    assert(queue.length === 3, 'sequential emit: 3 events queued')
    assert(queue[0].type === 'a', 'sequential emit: order preserved (first)')
    assert(queue[2].type === 'c', 'sequential emit: order preserved (last)')
  }

  // emit with custom id → 그대로 유지
  {
    const state = createReactiveState({
      events: { queue: [], lastProcessed: null, deadLetter: [] },
    })
    const { emit } = createEventReceiver(state)
    const event = emit({ type: 'x', id: 'custom-id' })
    assert(event.id === 'custom-id', 'emit custom id: preserved')
  }

  // ===========================================
  // wireEventHooks
  // ===========================================

  // idle 상태에서 이벤트 큐 → agent.run 호출
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      events: { queue: [], lastProcessed: null, deadLetter: [] },
    })

    let runCalled = false
    let runPrompt = null
    const mockAgent = {
      run: async (input) => { runCalled = true; runPrompt = input; return 'done' },
    }

    wireEventHooks({ state, agent: mockAgent })

    // emit triggers processing
    const { emit } = createEventReceiver(state)
    emit({ type: 'heartbeat', prompt: '점검' })
    await new Promise(r => setTimeout(r, 50))

    assert(runCalled, 'event processing: agent.run called')
    assert(runPrompt === '점검', 'event processing: correct prompt')
    assert(state.get('events.queue').length === 0, 'event processing: queue drained')
    assert(state.get('events.lastProcessed').type === 'heartbeat', 'event processing: lastProcessed set')
  }

  // working 상태에서 이벤트 → 처리 보류 (큐에 남음)
  {
    const state = createReactiveState({
      turnState: Phase.working('busy'),
      lastTurn: null,
      events: { queue: [], lastProcessed: null, deadLetter: [] },
    })

    const mockAgent = { run: async () => 'done' }
    wireEventHooks({ state, agent: mockAgent })

    const { emit } = createEventReceiver(state)
    emit({ type: 'test' })
    await new Promise(r => setTimeout(r, 50))

    assert(state.get('events.queue').length === 1, 'busy agent: event stays in queue')
  }

  // agent.run 실패 → deadLetter
  {
    const state = createReactiveState({
      turnState: Phase.idle(),
      lastTurn: null,
      events: { queue: [], lastProcessed: null, deadLetter: [] },
    })

    const mockAgent = { run: async () => { throw new Error('agent crash') } }
    wireEventHooks({ state, agent: mockAgent })

    const { emit } = createEventReceiver(state)
    emit({ type: 'bad' })
    await new Promise(r => setTimeout(r, 50))

    assert(state.get('events.queue').length === 0, 'failed event: removed from queue')
    const dl = state.get('events.deadLetter')
    assert(dl.length === 1, 'failed event: added to deadLetter')
    assert(dl[0].error === 'agent crash', 'failed event: error recorded')
  }

  // ===========================================
  // wireTodoHooks
  // ===========================================

  // 이벤트에 todo 필드 → TODO 생성
  {
    const state = createReactiveState({
      events: { lastProcessed: null },
      todos: [],
    })
    wireTodoHooks({ state })

    state.set('events.lastProcessed', {
      id: 'evt-1',
      type: 'pr_assigned',
      todo: { type: 'pr_review', title: 'Review PR #42', data: { url: '/pr/42' } },
    })
    await new Promise(r => setTimeout(r, 20))

    const todos = state.get('todos')
    assert(todos.length === 1, 'todo creation: 1 todo')
    assert(todos[0].type === 'pr_review', 'todo creation: correct type')
    assert(todos[0].sourceEventId === 'evt-1', 'todo creation: sourceEventId')
    assert(todos[0].done === false, 'todo creation: not done')
  }

  // todo 필드 없는 이벤트 → TODO 미생성
  {
    const state = createReactiveState({
      events: { lastProcessed: null },
      todos: [],
    })
    wireTodoHooks({ state })

    state.set('events.lastProcessed', { id: 'evt-2', type: 'heartbeat' })
    await new Promise(r => setTimeout(r, 20))

    assert(state.get('todos').length === 0, 'no todo field: no todo created')
  }

  // 멱등성: 같은 이벤트 재처리 → TODO 중복 없음
  {
    const state = createReactiveState({
      events: { lastProcessed: null },
      todos: [],
    })
    wireTodoHooks({ state })

    const event = {
      id: 'evt-dup',
      type: 'issue',
      todo: { type: 'issue_review', title: 'Check issue' },
    }

    state.set('events.lastProcessed', event)
    await new Promise(r => setTimeout(r, 20))
    state.set('events.lastProcessed', event)  // 재전송
    await new Promise(r => setTimeout(r, 20))

    assert(state.get('todos').length === 1, 'idempotent: no duplicate todo')
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
