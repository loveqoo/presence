import { randomUUID } from 'crypto'
import fp from '@presence/core/lib/fun-fp.js'

const { Maybe } = fp

// --- 순수 변환 ---

const withEventMeta = (event) => ({
  ...event,
  id: event.id || randomUUID(),
  receivedAt: Date.now(),
})

const eventToPrompt = (event) =>
  event.prompt || event.message || `이벤트 처리: ${event.type}`

const formatTodosAsLines = (todos) =>
  todos.map((t, i) =>
    `${i + 1}. [${t.type || 'task'}] ${t.title}${t.data?.detail ? ` — ${t.data.detail}` : ''}`
  )

// todo_review 이벤트용 동적 프롬프트 생성 (actors.js에서 호출)
const buildTodoReviewPrompt = (pendingTodos) =>
  `대기 중인 TODO 항목 ${pendingTodos.length}개가 있습니다:\n\n${formatTodosAsLines(pendingTodos).join('\n')}\n\n위 항목들을 사용자에게 안내하고, 처리 방법을 제안하세요. 직접 실행하지 말고 사용자의 응답을 기다리세요.`

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

export { createEventReceiver, withEventMeta, eventToPrompt, buildTodoReviewPrompt, formatTodosAsLines, todoFromEvent, isDuplicate }
