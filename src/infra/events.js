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

// --- createEventReceiver (deprecated) ---
// EventActor + createEmit로 대체됨. 기존 테스트 호환을 위해 유지.
const createEventReceiver = (state) => {
  const emit = (event) => {
    const withMeta = withEventMeta(event)
    const queue = state.get('events.queue') || []
    state.set('events.queue', [...queue, withMeta])
    return withMeta
  }

  return { emit }
}

export { createEventReceiver, withEventMeta, eventToPrompt, todoFromEvent, isDuplicate }
