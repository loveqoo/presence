import { randomUUID } from 'node:crypto'
import { createSession } from '../main.js'
import { SESSION_TYPE } from '../core/policies.js'

// =============================================================================
// SessionManager
// 세션 생명주기 관리. createGlobalContext()의 전역 인프라를 공유하면서
// 각 세션(대화 컨텍스트)을 독립적으로 생성/소멸.
//
// 세션 유형:
//   'user'      — 클라이언트 연결 기반. idle timeout 지원 예정 (Phase D).
//   'scheduled' — 스케줄 잡 전용 ephemeral 세션. 잡 완료 후 자동 소멸 (Phase D).
//
// onSessionCreated: 세션 생성 직후 호출되는 콜백. WS 브릿지 구독 등에 사용.
// =============================================================================

const createSessionManager = (globalCtx, { onSessionCreated } = {}) => {
  const sessions = new Map()  // id → { id, type, session }

  const create = ({ id, type = SESSION_TYPE.USER, persistenceCwd, onScheduledJobDone, idleTimeoutMs, onIdle } = {}) => {
    const sessionId = id ?? `user-${randomUUID()}`
    if (sessions.has(sessionId)) return sessions.get(sessionId)

    const session = createSession(globalCtx, { persistenceCwd, type, onScheduledJobDone, idleTimeoutMs, onIdle })
    const entry = { id: sessionId, type, session }
    sessions.set(sessionId, entry)
    onSessionCreated?.(entry)
    return entry
  }

  const get = (id) => sessions.get(id) ?? null

  const list = () => [...sessions.values()]

  const destroy = async (id) => {
    const entry = sessions.get(id)
    if (!entry) return
    sessions.delete(id)
    await entry.session.shutdown().catch(() => {})
  }

  return { create, get, list, destroy }
}

export { createSessionManager }
