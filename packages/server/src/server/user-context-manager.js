import { UserContext } from '@presence/infra/infra/user-context.js'
import { SESSION_TYPE } from '@presence/core/core/policies.js'

// =============================================================================
// UserContextManager: 유저별 UserContext 생명주기 관리.
// - 인증된 첫 요청/WS 시 해당 유저의 UserContext 생성
// - 모든 WS 연결이 끊기면 INACTIVITY_TIMEOUT_MS 후 자동 shutdown
// (인증 활성화 시에만 사용)
// =============================================================================

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000 // 30분

const buildUserContextManager = (env) => {
  const { bridge, configOverride } = env
  const userContexts = new Map()  // username → { userContext, wsConnections, lastActivity, shutdownTimer }

  const getOrCreate = async (username) => {
    if (userContexts.has(username)) return userContexts.get(username)
    const userContext = await UserContext.create(configOverride, {
      username,
      onSessionCreated: ({ id, type, session }) => {
        if (type !== SESSION_TYPE.SCHEDULED) bridge.watchSession(id, session.state)
      },
    })
    const entry = { userContext, wsConnections: new Set(), lastActivity: Date.now(), shutdownTimer: null }
    userContexts.set(username, entry)
    return entry
  }

  const touch = (username) => {
    const entry = userContexts.get(username)
    if (!entry) return
    entry.lastActivity = Date.now()
    if (entry.shutdownTimer) {
      clearTimeout(entry.shutdownTimer)
      entry.shutdownTimer = null
    }
  }

  const shutdownUser = async (username) => {
    const entry = userContexts.get(username)
    if (!entry) return
    userContexts.delete(username)
    if (entry.shutdownTimer) clearTimeout(entry.shutdownTimer)
    await entry.userContext.shutdown().catch(() => {})
  }

  const scheduleShutdown = (username) => {
    const entry = userContexts.get(username)
    if (!entry) return
    if (entry.wsConnections.size > 0) return
    if (entry.shutdownTimer) return
    entry.shutdownTimer = setTimeout(() => shutdownUser(username), INACTIVITY_TIMEOUT_MS)
  }

  const addWs = (username, ws) => {
    const entry = userContexts.get(username)
    if (!entry) return
    entry.wsConnections.add(ws)
    if (entry.shutdownTimer) {
      clearTimeout(entry.shutdownTimer)
      entry.shutdownTimer = null
    }
  }

  const removeWs = (username, ws) => {
    const entry = userContexts.get(username)
    if (!entry) return
    entry.wsConnections.delete(ws)
    if (entry.wsConnections.size === 0) scheduleShutdown(username)
  }

  const shutdownAll = async () => {
    const usernames = [...userContexts.keys()]
    await Promise.all(usernames.map(u => shutdownUser(u)))
  }

  const list = () => [...userContexts.entries()].map(([username, entry]) => ({ username, entry }))

  return { getOrCreate, touch, addWs, removeWs, shutdownAll, shutdownUser, list }
}

export { buildUserContextManager, INACTIVITY_TIMEOUT_MS }
