import { randomUUID } from 'crypto'
import fp from '@presence/core/lib/fun-fp.js'

const { Maybe } = fp

// =============================================================================
// Event primitives: 이벤트 메타 부여 + TODO 변환/표시.
// EventActor가 이 함수들로 이벤트 큐와 TODO 목록을 관리.
// =============================================================================

// id(UUID) + receivedAt 부여. 기존 id는 보존.
const withEventMeta = (event) => ({
  ...event,
  id: event.id || randomUUID(),
  receivedAt: Date.now(),
})

// 이벤트 → 에이전트 입력 프롬프트. prompt > message > fallback.
const eventToPrompt = (event) =>
  event.prompt || event.message || `이벤트 처리: ${event.type}`

const formatTodosAsLines = (todos) =>
  todos.map(t => {
    const type = t.payload?.type || t.type
    const suffix = type ? ` (${type})` : ''
    return `[${t.id}] ${t.title || 'untitled'}${suffix}`
  })

// todo_review 이벤트용 동적 프롬프트 (EventActor가 호출).
const buildTodoReviewPrompt = (pendingTodos) =>
  `대기 중인 TODO 항목 ${pendingTodos.length}개가 있습니다:\n\n${formatTodosAsLines(pendingTodos).join('\n')}\n\n위 항목들을 사용자에게 안내하고, 처리 방법을 제안하세요. 직접 실행하지 말고 사용자의 응답을 기다리세요.`

// 이벤트의 .todo 필드를 UserDataStore add 입력으로 변환. 없으면 Nothing.
const todoFromEvent = (event) =>
  Maybe.fromNullable(event.todo).map(todo => ({
    category: 'todo',
    status: 'ready',
    title: todo.title || event.type,
    payload: {
      sourceEventId: event.id,
      type: todo.type || event.type,
      data: todo.data || {},
    },
  }))

// normalized payload 기준 중복 체크
const isDuplicate = (todos, eventId) =>
  todos.some(t => t.payload?.sourceEventId === eventId)

// state projection 동기화: store → state. write 직후 + session init 직후만 호출.
const syncTodosProjection = (state, userDataStore) => {
  const todos = userDataStore.list({ category: 'todo', orderBy: 'created_at_asc' })
  state.set('todos', todos)
}

export { withEventMeta, eventToPrompt, buildTodoReviewPrompt, formatTodosAsLines, todoFromEvent, isDuplicate, syncTodosProjection }
