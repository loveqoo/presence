// FP-73 — admin login/logout/whoami CLI. cli.js main switch 의 'admin' 2-단계 subcommand.
// MVP 범위: file lock / refresh race 방어 미포함, single-admin sequential 가정 (plan §2.5).

import {
  saveAdminSession,
  loadAdminSession,
  clearAdminSession,
  isAccessNearExpiry,
  decodeAccessExp,
  adminSessionPath,
} from './admin-session.js'
import {
  promptPassword, httpJson, mapHttpFetchError, resolveBaseUrl,
  CliError, dispatchWithCliErrorHandling, AUTH_PATHS,
} from './cli-utils.js'

class CliAdminError extends CliError {
  constructor(stderrMessage) { super(stderrMessage, 'CliAdminError') }
}

// stale ENV 감지 — admin login 직후 + logout 직후 표시. 셸 변수가 파일을 가립니다 안내.
const warnStaleEnv = () => {
  if (!process.env.PRESENCE_ADMIN_TOKEN) return
  console.warn('주의: PRESENCE_ADMIN_TOKEN env 가 설정되어 있어 파일보다 우선합니다.')
  console.warn('  파일 기반 자동 동작을 원하면: unset PRESENCE_ADMIN_TOKEN')
}

async function cmdAdminLogin({ username, password }) {
  const resolvedUsername = username || 'admin'
  const passwordFromFlag = password
  const passwordFromEnv = process.env.PRESENCE_ADMIN_PASSWORD
  if (passwordFromFlag) {
    console.warn('주의: --password flag 는 process listing 으로 노출 가능. PRESENCE_ADMIN_PASSWORD env 권장.')
  }
  const resolvedPassword = passwordFromFlag || passwordFromEnv || await promptPassword('Password: ')

  const baseUrl = resolveBaseUrl()
  let res
  try {
    res = await httpJson(`${baseUrl}${AUTH_PATHS.LOGIN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: resolvedUsername, password: resolvedPassword }),
    })
  } catch (err) {
    throw mapHttpFetchError(err, CliAdminError, 'admin login')
  }

  if (!res.ok) {
    throw new CliAdminError(`admin login: 로그인 실패 (HTTP ${res.status}): ${res.body?.error ?? '(empty)'}`)
  }

  // mustChangePassword 차단 — 저장하면 useless token 이 디스크에 남음. 안내 후 exit.
  if (res.body.mustChangePassword === true) {
    throw new CliAdminError([
      'admin login: 비밀번호 변경이 필요합니다 (mustChangePassword=true).',
      `  서버 호스트에서: npm run user -- passwd --username ${resolvedUsername}`,
      '  (passwd 는 로컬 user-store 만 변경하므로 서버 호스트에서 실행해야 함)',
      '비밀번호 변경 후 다시 admin login 하세요.',
    ].join('\n'))
  }

  if (!res.body.accessToken || !res.body.refreshToken) {
    throw new CliAdminError('admin login: 응답에 토큰이 누락되었습니다 (서버 응답 형식이 호환되지 않음).')
  }

  const accessExp = decodeAccessExp(res.body.accessToken)
  saveAdminSession({
    username: resolvedUsername,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    accessExp,
  })

  console.log(`Logged in as ${resolvedUsername}. Saved to ${adminSessionPath()} (mode 0600).`)
  warnStaleEnv()
}

async function cmdAdminLogout() {
  const session = loadAdminSession()
  if (!session) {
    console.log('Not logged in.')
    return
  }

  const baseUrl = resolveBaseUrl()
  try {
    // best-effort 호출 — 서버 도달 실패도 로컬 파일 삭제는 진행. httpJson 의 응답 body 는 사용 안 함.
    await httpJson(`${baseUrl}${AUTH_PATHS.LOGOUT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    })
  } catch (err) {
    console.warn(`logout 서버 통신 실패 — 로컬 파일만 삭제: ${err.message}`)
  }
  clearAdminSession()
  console.log(`Logged out (${session.username}).`)
  warnStaleEnv()
}

function cmdAdminWhoami() {
  const session = loadAdminSession()
  if (!session) {
    console.log('Not logged in.')
    return
  }
  const status = isAccessNearExpiry(session) ? '만료 임박 (다음 호출에서 자동 refresh)' : '활성'
  console.log(`Username: ${session.username}`)
  console.log(`Access expires: ${session.accessExp} (${status})`)
  console.log(`Saved at: ${session.savedAt}`)
}

export const dispatchAdmin = (action, flags) => dispatchWithCliErrorHandling(async () => {
  switch (action) {
    case 'login':   return await cmdAdminLogin({ username: flags.username, password: flags.password })
    case 'logout':  return await cmdAdminLogout()
    case 'whoami':  return cmdAdminWhoami()
    default:
      throw new CliAdminError(`Unknown admin action: ${action}\nActions: login, logout, whoami`)
  }
})
