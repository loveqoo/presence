// FP-73 — admin-session 모듈 단위 테스트.
// AS1~AS10 — 파일 권한 / atomic / 만료 / decode JWT.

import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ADMIN_SESSION_DRIFT_BUFFER_S,
  AdminSessionError,
  adminSessionPath,
  saveAdminSession,
  loadAdminSession,
  clearAdminSession,
  isAccessNearExpiry,
  decodeAccessExp,
} from '@presence/infra/infra/auth/admin-session.js'
import { createTokenService } from '@presence/infra/infra/auth/token.js'
import { assert, summary } from '../../../test/lib/assert.js'

const createTmp = () => mkdtempSync(join(tmpdir(), 'admin-session-'))

const baseSession = (overrides = {}) => ({
  username: 'admin',
  accessToken: 'eyJ.access.fake',
  refreshToken: 'eyJ.refresh.fake',
  accessExp: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  ...overrides,
})

console.log('admin-session unit tests (FP-73 AS1~AS10)')

// AS1 — saveAdminSession → 파일 존재 + JSON parse + payload 일치
{
  const dir = createTmp()
  try {
    saveAdminSession(baseSession(), { basePath: dir })
    const path = adminSessionPath({ basePath: dir })
    assert(existsSync(path), 'AS1: 파일 생성됨')
    const loaded = loadAdminSession({ basePath: dir })
    assert(loaded.username === 'admin', 'AS1: username 일치')
    assert(loaded.accessToken === 'eyJ.access.fake', 'AS1: accessToken 일치')
    assert(loaded.refreshToken === 'eyJ.refresh.fake', 'AS1: refreshToken 일치')
    assert(typeof loaded.savedAt === 'string', 'AS1: savedAt ISO 문자열')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// AS2 — 파일 mode 정확히 0o600
{
  const dir = createTmp()
  try {
    saveAdminSession(baseSession(), { basePath: dir })
    const path = adminSessionPath({ basePath: dir })
    const mode = statSync(path).mode & 0o777
    assert(mode === 0o600, `AS2: file mode 0o600 (got ${mode.toString(8)})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// AS3 — 부모 디렉토리 mode 0o700 (신규 생성 시)
{
  const dir = createTmp()
  rmSync(dir, { recursive: true, force: true })  // 부모 디렉토리도 삭제 후 검증
  try {
    saveAdminSession(baseSession(), { basePath: dir })
    const dirMode = statSync(dir).mode & 0o777
    assert(dirMode === 0o700, `AS3: dir mode 0o700 (got ${dirMode.toString(8)})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// AS4 — loadAdminSession 파일 없음 → null
{
  const dir = createTmp()
  try {
    const result = loadAdminSession({ basePath: dir })
    assert(result === null, 'AS4: 파일 없음 → null')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// AS5 — mode 0o644 → throw with reason='mode'
{
  const dir = createTmp()
  try {
    saveAdminSession(baseSession(), { basePath: dir })
    const path = adminSessionPath({ basePath: dir })
    chmodSync(path, 0o644)
    let caught = null
    try { loadAdminSession({ basePath: dir }) } catch (err) { caught = err }
    assert(caught instanceof AdminSessionError, 'AS5: AdminSessionError throw')
    assert(caught?.reason === 'mode', `AS5: reason='mode' (got ${caught?.reason})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// AS6 — 손상 JSON → throw with reason='corrupt'
{
  const dir = createTmp()
  try {
    const path = adminSessionPath({ basePath: dir })
    writeFileSync(path, '{ broken json', 'utf-8')
    chmodSync(path, 0o600)
    let caught = null
    try { loadAdminSession({ basePath: dir }) } catch (err) { caught = err }
    assert(caught instanceof AdminSessionError, 'AS6: AdminSessionError throw')
    assert(caught?.reason === 'corrupt', `AS6: reason='corrupt' (got ${caught?.reason})`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// AS7 — clearAdminSession 파일 있음 → 삭제 + true
{
  const dir = createTmp()
  try {
    saveAdminSession(baseSession(), { basePath: dir })
    const result = clearAdminSession({ basePath: dir })
    assert(result === true, 'AS7: existed → true')
    assert(!existsSync(adminSessionPath({ basePath: dir })), 'AS7: 파일 삭제됨')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// AS8 — clearAdminSession 파일 없음 → false (silent)
{
  const dir = createTmp()
  try {
    const result = clearAdminSession({ basePath: dir })
    assert(result === false, 'AS8: 파일 없음 → false')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// AS9 — isAccessNearExpiry: 30s 전 true, 31s 전 false
{
  const now = Math.floor(Date.now() / 1000)
  const sessionExpIn29s = baseSession({ accessExp: new Date((now + 29) * 1000).toISOString() })
  assert(
    isAccessNearExpiry(sessionExpIn29s) === true,
    `AS9: 29s 후 만료 → near (drift buffer ${ADMIN_SESSION_DRIFT_BUFFER_S}s)`,
  )
  const sessionExpIn31s = baseSession({ accessExp: new Date((now + 31) * 1000).toISOString() })
  assert(
    isAccessNearExpiry(sessionExpIn31s) === false,
    `AS9: 31s 후 만료 → not near`,
  )
}

// AS10 — decodeAccessExp 실 signAccessToken 출력에 정확한 ISO
{
  const dir = createTmp()
  try {
    const tokenService = createTokenService({ basePath: dir })
    const beforeSec = Math.floor(Date.now() / 1000)
    const accessToken = tokenService.signAccessToken({ sub: 'admin', roles: ['admin'] })
    const isoExp = decodeAccessExp(accessToken)
    const decodedSec = Math.floor(new Date(isoExp).getTime() / 1000)
    // ACCESS_TOKEN_EXPIRY_S = 15min = 900s. 토큰 발급 시 within ±2s 오차 허용.
    assert(
      decodedSec >= beforeSec + 898 && decodedSec <= beforeSec + 902,
      `AS10: decoded exp 이 발급 시점 +900s 근처 (got ${decodedSec - beforeSec}s offset)`,
    )
    assert(
      typeof isoExp === 'string' && isoExp.endsWith('Z'),
      `AS10: ISO 8601 UTC 문자열 (got ${isoExp})`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

summary()
