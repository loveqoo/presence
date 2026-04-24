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

  // A2A Phase 1 S1 수신 session 라우팅 (a2a-internal.md §4.2):
  //   AGENT type session 중 session.agentId 가 매치되는 entry 를 찾는다.
  //   USER session 과 같은 agentId 가 공존해도 (dual-homed: default/manager) AGENT 만 선택.
  //   → SendA2aMessage 가 유저 대화 흐름 (UserSession) 을 교란하지 않음.
  //
  // tagged union 반환:
  //   { kind: 'ok', entry }           — 정확히 1 개 AGENT session 매치
  //   { kind: 'not-registered', entry: null } — 0 개 매치 (등록된 AGENT session 없음)
  //   { kind: 'ambiguous', entry: null }      — 2 개 이상 (이론상 발생 없음, 방어)
  const findAgentSession = (agentId) => {
    const matches = [...sessions.values()].filter(
      entry => entry.type === SESSION_TYPE.AGENT && entry.session.agentId === agentId,
    )
    if (matches.length === 0) return { kind: 'not-registered', entry: null }
    if (matches.length > 1) return { kind: 'ambiguous', entry: null }
    return { kind: 'ok', entry: matches[0] }
  }

  // A2A Phase 1 S2 — response 송신자 조회 (a2a-internal.md §4.2):
  //   SendA2aMessage 는 USER session 의 turn 에서도 호출 가능하므로 response 는
  //   대화창으로 돌아가야 유저가 확인 가능. USER + AGENT 양쪽 검색.
  //   우선순위: AGENT 선호 (delegate 경로) → 없으면 USER fallback.
  const findSenderSession = (agentId) => {
    const agents = [...sessions.values()].filter(
      entry => entry.type === SESSION_TYPE.AGENT && entry.session.agentId === agentId,
    )
    if (agents.length > 1) return { kind: 'ambiguous', entry: null }
    if (agents.length === 1) return { kind: 'ok', entry: agents[0] }
    const users = [...sessions.values()].filter(
      entry => entry.type === SESSION_TYPE.USER && entry.session.agentId === agentId,
    )
    if (users.length > 1) return { kind: 'ambiguous', entry: null }
    if (users.length === 1) return { kind: 'ok', entry: users[0] }
    return { kind: 'not-registered', entry: null }
  }

  return { create, get, list, destroy, findAgentSession, findSenderSession }
}

export { createSessionManager }
