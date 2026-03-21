import { randomUUID } from 'crypto'
import fp from '../lib/fun-fp.js'

const { Maybe } = fp

// --- 순수 변환 ---

const withEventMeta = (event) => ({
  ...event,
  id: event.id || randomUUID(),
  receivedAt: Date.now(),
})

const eventToPrompt = (event) =>
  event.prompt || event.message || `이벤트 처리: ${event.type}`

const todoFromEvent = (event) =>
  Maybe.fromNullable(event.todo).map(todo => ({
    id: randomUUID(),
    sourceEventId: event.id,
    type: todo.type || event.type,
    title: todo.title || event.type,
    data: todo.data || {},
    createdAt: Date.now(),
    done: false,
  }))

const isDuplicate = (todos, eventId) =>
  todos.some(t => t.sourceEventId === eventId)

// --- 이벤트 수신 ---

const createEventReceiver = (state) => {
  const emit = (event) => {
    const withMeta = withEventMeta(event)
    const queue = state.get('events.queue') || []
    state.set('events.queue', [...queue, withMeta])
    return withMeta
  }

  return { emit }
}

// --- 이벤트 처리 hook ---

const wireEventHooks = ({ state, agent, logger }) => {
  let processing = false

  const processNext = async () => {
    if (processing) return
    const ts = state.get('turnState')
    if (!ts || ts.tag !== 'idle') return

    const queue = state.get('events.queue') || []
    if (queue.length === 0) return

    processing = true
    const [event, ...rest] = queue
    state.set('events.queue', rest)
    state.set('events.inFlight', event)

    try {
      await agent.run(eventToPrompt(event))
      state.set('events.lastProcessed', event)
    } catch (e) {
      const deadLetter = state.get('events.deadLetter') || []
      state.set('events.deadLetter', [...deadLetter, {
        ...event,
        error: e.message || String(e),
        stack: e.stack || null,
        failedAt: Date.now(),
      }])
      if (logger) logger.warn('Event processing failed', { eventId: event.id, error: e.message, stack: e.stack })
    } finally {
      state.set('events.inFlight', null)
      processing = false
    }
  }

  state.hooks.on('events.queue', processNext)
  state.hooks.on('turnState', (phase) => {
    if (phase.tag === 'idle') processNext()
  })
}

// --- TODO hook ---
// Maybe로 todo 생성 여부 판단, isDuplicate로 멱등성 보장.

const wireTodoHooks = ({ state, logger }) => {
  state.hooks.on('events.lastProcessed', (event) => {
    Maybe.fold(
      () => {},
      todo => {
        const todos = state.get('todos') || []
        if (isDuplicate(todos, event.id)) return
        state.set('todos', [...todos, todo])
        if (logger) logger.info('TODO added', { todoId: todo.id, type: todo.type })
      },
      todoFromEvent(event),
    )
  })
}

export { createEventReceiver, wireEventHooks, wireTodoHooks, withEventMeta, eventToPrompt, todoFromEvent, isDuplicate }
