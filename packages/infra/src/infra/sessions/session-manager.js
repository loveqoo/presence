import { randomUUID } from 'node:crypto'
import { Session } from './index.js'
import { SESSION_TYPE } from '../constants.js'

// =============================================================================
// SessionManager: UserContext 하위에서 세션 생명주기 관리.
// UserContext의 인프라를 공유하면서 각 세션을 독립적으로 생성/소멸.
//
// 세션 유형:
//   'user'      — 클라이언트 연결 기반
//   'scheduled' — 스케줄 잡 전용 ephemeral 세션
//   'agent'     — 에이전트 위임 전용 세션
//
// onSessionCreated: 세션 생성 직후 호출되는 콜백. WS 브릿지 구독 등에 사용.
// =============================================================================

const createSessionManager = (userContext, opts = {}) => {
  const { onSessionCreated } = opts
  const sessions = new Map()  // id → { id, type, owner, session }

  const create = (params = {}) => {
    const { id, type = SESSION_TYPE.USER, owner = null, userId, agentId, persistenceCwd, workingDir, onScheduledJobDone, idleTimeoutMs, onIdle } = params
    const sessionId = id ?? `user-${randomUUID()}`
    if (sessions.has(sessionId)) return sessions.get(sessionId)

    // agentId 필수 — docs/design/agent-identity-model.md §5.1. Session constructor 가 검증 throw.
    const session = Session.create(userContext, { persistenceCwd, workingDir, type, userId, agentId, onScheduledJobDone, idleTimeoutMs, onIdle })
    const entry = Object.freeze({ id: sessionId, type, owner, session })
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
    await entry.session.cleanup().catch(() => {})
  }

  return { create, get, list, destroy }
}

export { createSessionManager }
