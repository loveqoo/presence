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
  todos.map((t, i) =>
    `${i + 1}. [${t.type || 'task'}] ${t.title}${t.data?.detail ? ` — ${t.data.detail}` : ''}`
  )

// todo_review 이벤트용 동적 프롬프트 (EventActor가 호출).
const buildTodoReviewPrompt = (pendingTodos) =>
  `대기 중인 TODO 항목 ${pendingTodos.length}개가 있습니다:\n\n${formatTodosAsLines(pendingTodos).join('\n')}\n\n위 항목들을 사용자에게 안내하고, 처리 방법을 제안하세요. 직접 실행하지 말고 사용자의 응답을 기다리세요.`

// 이벤트의 .todo 필드를 TODO 레코드로 변환. 없으면 Nothing.
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

export { withEventMeta, eventToPrompt, buildTodoReviewPrompt, formatTodosAsLines, todoFromEvent, isDuplicate }
