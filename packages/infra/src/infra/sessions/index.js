import { SESSION_TYPE } from '../constants.js'
import fp from '@presence/core/lib/fun-fp.js'
import { Session } from './session.js'
import { UserSession } from './user-session.js'
import { EphemeralSession } from './ephemeral-session.js'

const { Reader } = fp

// =============================================================================
// Session Factory: 유형별 세션 인스턴스 생성.
// =============================================================================

const createR = Reader.asks(({ globalCtx, ...opts }) => createSession(globalCtx, opts))

const createSession = (globalCtx, { type = SESSION_TYPE.USER, ...opts } = {}) => {
  switch (type) {
    case SESSION_TYPE.USER: return new UserSession(globalCtx, opts)
    case SESSION_TYPE.SCHEDULED: return new EphemeralSession(globalCtx, opts)
    case SESSION_TYPE.AGENT: return new EphemeralSession(globalCtx, opts)
    default: throw new Error(`Unknown session type: ${type}`)
  }
}

// Session.create / Session.createR를 static으로 부착
Session.create = createSession
Session.createR = createR

export { Session }
