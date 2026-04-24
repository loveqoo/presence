import { EVENT_TYPE } from '@presence/core/core/policies.js'
import { withEventMeta } from '../events.js'
import { TODO_STATUS } from './a2a-queue-store.js'

// =============================================================================
// A2A Response Dispatcher — a2a-internal.md §4.2 + §6.3
//
// 수신 agent turn 완료/실패 또는 UserContext expire tick 시 호출.
// 책임:
//   1. response row 생성 (A2aQueueStore.enqueueResponse)
//   2. sender session 조회 (sessionManager.findSenderSession — USER + AGENT)
//   3. sender session 의 eventActor 에 a2a_response event enqueue
//   4. sender 부재 / enqueue 실패 시 response row status='orphaned' 로 전이
//
// 반환 계약 (a2a-internal.md v4 §4.4):
//   { enqueued: boolean, responseId: UUID|null, reason?: string }
//   - 내부 try/catch 로 throw 하지 않음 (정상 경로에서 Promise reject 없음)
//   - caller 의 .catch(...) 는 예기치 못한 JS 런타임 예외 방어용
// =============================================================================

const dispatchResponse = async (opts) => {
  const a2aQueueStore = opts.a2aQueueStore
  const sessionManager = opts.sessionManager
  const logger = opts.logger
  const request = opts.request
  const status = opts.status
  const payload = opts.payload
  const error = opts.error

  try {
    if (!request?.id || !request?.fromAgentId || !request?.toAgentId) {
      logger?.warn?.('dispatchResponse: invalid request', { request })
      return { enqueued: false, responseId: null, reason: 'invalid-request' }
    }

    // findSenderSession 은 USER + AGENT 양쪽 검색 (AGENT 우선).
    // findAgentSession (S1 수신 라우팅) 과 별개 API — response 는 대화창에도 표시되어야 유저 확인 가능.
    const sender = sessionManager.findSenderSession(request.fromAgentId)
    const effectiveStatus = sender.kind === 'ok' ? status : TODO_STATUS.ORPHANED

    const responseRow = a2aQueueStore.enqueueResponse({
      correlationId: request.id,
      fromAgentId: request.toAgentId,  // 역방향
      toAgentId: request.fromAgentId,
      payload: payload ?? '',
      status: effectiveStatus,
      error: error ?? null,
    })

    if (sender.kind !== 'ok') {
      logger?.warn?.('A2A response orphaned', { requestId: request.id, senderKind: sender.kind })
      return { enqueued: false, responseId: responseRow.id, reason: sender.kind }
    }

    const senderEventActor = sender.entry?.session?.actors?.eventActor
    if (!senderEventActor) {
      a2aQueueStore.markOrphaned(responseRow.id)
      logger?.warn?.('A2A response: sender session eventActor missing', { requestId: request.id })
      return { enqueued: false, responseId: responseRow.id, reason: 'no-event-actor' }
    }

    const event = withEventMeta({
      id: responseRow.id,
      type: EVENT_TYPE.A2A_RESPONSE,
      correlationId: request.id,
      fromAgentId: request.toAgentId,
      toAgentId: request.fromAgentId,
      category: request.category ?? 'todo',
      status: effectiveStatus,
      payload,
      error,
    })

    // Task.fork → Promise 변환 (Task.fork 는 throw 하지 않지만 stale actor 예외 방어).
    const enqueueResult = await new Promise(resolve => {
      try {
        senderEventActor.enqueue(event).fork(
          (err) => resolve({ ok: false, err }),
          () => resolve({ ok: true }),
        )
      } catch (err) {
        resolve({ ok: false, err })
      }
    })

    if (!enqueueResult.ok) {
      a2aQueueStore.markOrphaned(responseRow.id)
      logger?.warn?.('A2A response enqueue failed', { requestId: request.id, error: enqueueResult.err?.message })
      return { enqueued: false, responseId: responseRow.id, reason: 'enqueue-failed' }
    }
    return { enqueued: true, responseId: responseRow.id }
  } catch (err) {
    // 예상치 못한 예외 — 상위로 전파하지 않음
    logger?.warn?.('A2A dispatchResponse unexpected error', { requestId: request?.id, error: err?.message })
    return { enqueued: false, responseId: null, reason: 'unexpected-error' }
  }
}

export { dispatchResponse }
