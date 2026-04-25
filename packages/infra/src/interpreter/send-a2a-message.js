import fp from '@presence/core/lib/fun-fp.js'
import { Interpreter } from '@presence/core/interpreter/compose.js'
import { assertValidAgentId } from '@presence/core/core/agent-id.js'
import { EVENT_TYPE, A2A } from '@presence/core/core/policies.js'
import { TODO_STATUS } from '../infra/a2a/a2a-queue-store.js'
import { withEventMeta } from '../infra/events.js'

const { Task, Reader } = fp

// =============================================================================
// SendA2aMessage Interpreter — A2A Phase 1 (v8 rename)
//
// `Op.SendA2aMessage(to, payload, { timeoutMs?, category? })` → 같은 유저의
// 다른 agent 에게 비동기 메시지를 전달한다.
//
// 반환 (a2a-internal.md §4.4):
//   { requestId: UUID|null, accepted: boolean, error?: string }
//
// 처리 흐름:
//   1. validateTarget — qualified form / ownership / session routing / archived
//   2. enqueueRequest → SQLite row 생성 (pending, category 포함)
//   3. 수신 AGENT session 의 eventActor 에 a2a_request 이벤트 enqueue
//   4. 결과를 op.next(result) 로 반환
//
// 거부 경로:
//   - row 생성 전: validateTarget 실패 (requestId=null)
//   - row 생성 후: archived / session 해제 race / enqueue 실패 (requestId≠null, audit)
//
// 권한: S1 은 인터프리터 내부 하드코딩 (ownership + archived). S5 에서
// Cedar `a2a-delegate` 액션으로 이관.
// =============================================================================

// 관측 계약 (외부에 노출되는 error 문자열, 9 종 — S4 v9 에서 QUEUE_FULL 추가).
const SEND_A2A_ERROR = Object.freeze({
  INVALID_AGENT_ID:   'invalid-agent-id',
  OWNERSHIP_DENIED:   'ownership-denied',
  NOT_REGISTERED:     'target-not-registered',
  SESSION_AMBIGUOUS:  'session-routing-ambiguous',
  REGISTRY_MISSING:   'registry-missing',
  ARCHIVED:           'target-archived',
  SESSION_NOT_FOUND:  'target-session-not-found',
  ENQUEUE_FAILED:     'queue-enqueue-failed',
  QUEUE_FULL:         'queue-full',
})

const usernameOf = (agentId) => agentId.split('/')[0]

// Maybe unwrap — fun-fp-js Maybe.Just({value}) / Maybe.Nothing() 에서 entry 추출.
const unwrapMaybeEntry = (maybe) => {
  if (!maybe) return null
  if (typeof maybe.isNothing === 'function' && maybe.isNothing()) return null
  return maybe.value ?? null
}

// Target 검증 — Cedar 이관 시 { caller, action, resource } 매핑 대상.
// 반환: { ok: true, entry, archived } | { ok: false, error }
// 순수 함수 — 외부 의존성은 파라미터로 전달 (Reader 환경 안에서 호출됨).
const validateTarget = (opts) => {
  const to = opts.to
  const currentAgentId = opts.currentAgentId
  const agentRegistry = opts.agentRegistry
  const sessionManager = opts.sessionManager

  try { assertValidAgentId(to) }
  catch (_) { return { ok: false, error: SEND_A2A_ERROR.INVALID_AGENT_ID } }

  if (usernameOf(to) !== usernameOf(currentAgentId)) {
    return { ok: false, error: SEND_A2A_ERROR.OWNERSHIP_DENIED }
  }

  const routing = sessionManager.findAgentSession(to)
  if (routing.kind === 'not-registered') {
    return { ok: false, error: SEND_A2A_ERROR.NOT_REGISTERED }
  }
  if (routing.kind === 'ambiguous') {
    return { ok: false, error: SEND_A2A_ERROR.SESSION_AMBIGUOUS }
  }

  const registryEntry = unwrapMaybeEntry(agentRegistry?.get?.(to))
  if (!registryEntry) {
    return { ok: false, error: SEND_A2A_ERROR.REGISTRY_MISSING }
  }

  return { ok: true, entry: routing.entry, archived: registryEntry.archived === true }
}

// Task.fromPromise 래퍼 — actor.enqueue 는 Task 를 반환하므로 fork → Promise.
const forkToPromise = (task) => new Promise((resolve, reject) => {
  try { task.fork(reject, resolve) } catch (err) { reject(err) }
})

const sendA2aInterpreterR = Reader.asks((env) => {
  const { ST, a2aQueueStore, agentRegistry, sessionManager, currentAgentId } = env
  const logger = env.logger
  return new Interpreter(['SendA2aMessage'], (op) => {
  const to = op.to
  const payload = op.payload
  const timeoutMs = op.timeoutMs ?? null
  const category = op.category ?? 'todo'

  // 인프라 미주입 경로 (test interpreter 등) → not-registered 로 즉시 응답
  if (!a2aQueueStore || !sessionManager) {
    return ST.of(op.next({ requestId: null, accepted: false, error: SEND_A2A_ERROR.NOT_REGISTERED }))
  }

  const validation = validateTarget({ to, currentAgentId, agentRegistry, sessionManager })
  if (!validation.ok) {
    return ST.of(op.next({ requestId: null, accepted: false, error: validation.error }))
  }

  // archived: queue 에 fail row (감사)
  if (validation.archived) {
    const msg = a2aQueueStore.enqueueRequest({
      fromAgentId: currentAgentId, toAgentId: to, payload, timeoutMs, category,
    })
    a2aQueueStore.markFailed(msg.id, SEND_A2A_ERROR.ARCHIVED)
    return ST.of(op.next({ requestId: msg.id, accepted: false, error: SEND_A2A_ERROR.ARCHIVED }))
  }

  // 정상 경로: 큐 상한 enforcement (트랜잭션 내부 COUNT+INSERT, race-free).
  //   초과 시 store 가 status='failed', error='queue-full' row 를 직접 INSERT — interpreter 는 row.status 보고 분기.
  const msg = a2aQueueStore.enqueueRequestBounded(
    { fromAgentId: currentAgentId, toAgentId: to, payload, timeoutMs, category },
    A2A.QUEUE_MAX_PER_AGENT,
  )
  if (msg.status === TODO_STATUS.FAILED && msg.error === SEND_A2A_ERROR.QUEUE_FULL) {
    return ST.of(op.next({ requestId: msg.id, accepted: false, error: SEND_A2A_ERROR.QUEUE_FULL }))
  }

  const receiverSession = validation.entry?.session
  const receiverEventActor = receiverSession?.actors?.eventActor ?? receiverSession?.eventActor
  if (!receiverEventActor) {
    a2aQueueStore.markFailed(msg.id, SEND_A2A_ERROR.SESSION_NOT_FOUND)
    return ST.of(op.next({ requestId: msg.id, accepted: false, error: SEND_A2A_ERROR.SESSION_NOT_FOUND }))
  }

  const event = withEventMeta({
    id: msg.id,
    type: EVENT_TYPE.A2A_REQUEST,
    prompt: payload,
    fromAgentId: currentAgentId,
    toAgentId: to,
    requestId: msg.id,
    category,
  })

  // StateT(Task) 에 catchError 가 없으므로 Promise 단에서 에러를 값으로 변환 (delegate.js 패턴)
  const enqueuePromise = forkToPromise(receiverEventActor.enqueue(event))
    .then(() => ({ accepted: true, error: undefined }))
    .catch((err) => {
      a2aQueueStore.markFailed(msg.id, SEND_A2A_ERROR.ENQUEUE_FAILED)
      logger?.warn?.('SendA2aMessage enqueue failed', { error: err?.message ?? String(err), requestId: msg.id })
      return { accepted: false, error: SEND_A2A_ERROR.ENQUEUE_FAILED }
    })
  return ST.lift(Task.fromPromise(() => enqueuePromise)())
    .map((outcome) => op.next({ requestId: msg.id, accepted: outcome.accepted, error: outcome.error }))
  })
})

export { sendA2aInterpreterR, SEND_A2A_ERROR, validateTarget }
