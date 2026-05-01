// FP-73 — admin-session 파일 관리. `~/.presence/admin-session.json` (0o600).
// admin login → 파일 저장 → cli-policy.js 가 ENV 없이 자동 로드 + 만료 임박 시 자동 refresh.
// MVP 범위: race 방어 (lock/CAS) 미포함, single-admin sequential 가정 (plan §2.5).

import { existsSync, statSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Config } from '../config.js'
import { atomicWriteJson } from '../fs-utils.js'
import { decodeJwtPayload } from './token.js'

// drift buffer: 로컬 시계가 30s 이내로 어긋날 경우에도 만료를 안전 인지.
const ADMIN_SESSION_DRIFT_BUFFER_S = 30

class AdminSessionError extends Error {
  constructor(message, { reason } = {}) {
    super(message)
    this.name = 'AdminSessionError'
    this.reason = reason
  }
}

function adminSessionPath({ basePath } = {}) {
  const dir = Config.resolveDir(basePath)
  return join(dir, 'admin-session.json')
}

function saveAdminSession({ username, accessToken, refreshToken, accessExp }, { basePath } = {}) {
  const dir = Config.resolveDir(basePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'admin-session.json')
  atomicWriteJson(
    path,
    { username, accessToken, refreshToken, accessExp, savedAt: new Date().toISOString() },
    { mode: 0o600 },
  )
}

function loadAdminSession({ basePath } = {}) {
  const path = adminSessionPath({ basePath })
  if (!existsSync(path)) return null

  const stat = statSync(path)
  if ((stat.mode & 0o077) !== 0) {
    throw new AdminSessionError(
      `mode ${(stat.mode & 0o777).toString(8)} (group/other 비트가 설정됨)`,
      { reason: 'mode' },
    )
  }

  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    throw new AdminSessionError(err.message, { reason: 'corrupt' })
  }
}

function clearAdminSession({ basePath } = {}) {
  const path = adminSessionPath({ basePath })
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

function epochOfIso(iso) {
  return Math.floor(new Date(iso).getTime() / 1000)
}

function isAccessNearExpiry(session, { driftBufferS = ADMIN_SESSION_DRIFT_BUFFER_S } = {}) {
  const now = Math.floor(Date.now() / 1000)
  return now + driftBufferS >= epochOfIso(session.accessExp)
}

// JWT exp 클레임 → ISO 8601. payload 디코딩은 token.js 의 공통 helper 가 담당.
function decodeAccessExp(jwt) {
  const payload = decodeJwtPayload(jwt)
  if (typeof payload.exp !== 'number') throw new Error('JWT missing exp claim')
  return new Date(payload.exp * 1000).toISOString()
}

export {
  ADMIN_SESSION_DRIFT_BUFFER_S,
  AdminSessionError,
  adminSessionPath,
  saveAdminSession,
  loadAdminSession,
  clearAdminSession,
  isAccessNearExpiry,
  decodeAccessExp,
}
