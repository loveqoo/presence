// KG-27 P4 — Cedar 정책 운영자 CLI 핸들러. cli.js 의 main switch 에서 dispatchPolicy 호출.
// lint (parse + schema validate) / list (카테고리 표) / reload (P5, hot reload) / version.
// FP-73: AdminTokenManager 가 admin-session.json 파일 fallback + 자동 refresh + 401 retry.

import { readFileSync } from 'node:fs'
import { lintPolicyText, listPolicyFiles, readSchemaText } from '../authz/cedar/index.js'
import {
  requireFlag, httpJson, mapHttpFetchError, resolveBaseUrl,
  CliError, dispatchWithCliErrorHandling,
  AUTH_PATHS, ADMIN_PATHS,
} from './cli-utils.js'
import {
  loadAdminSession,
  saveAdminSession,
  clearAdminSession,
  isAccessNearExpiry,
  decodeAccessExp,
  AdminSessionError,
} from './admin-session.js'

// CLI handler 가 throw 하면 dispatchPolicy 가 catch + process.exit(1) 로 단일 수렴.
// 각 handler 는 비즈니스 로직만 — exit 처리는 dispatch 경계.
class CliPolicyError extends CliError {
  constructor(stderrMessage) { super(stderrMessage, 'CliPolicyError') }
}

// FP-73 — admin token 흐름의 응집 단위. baseUrl + ENV snapshot 을 인스턴스에 묶음.
//   resolveToken: ENV 우선 → 파일 → 부재 안내 → 만료 임박 시 자동 refresh.
//   fetchAdminWithRetry: clock drift 대응 1회 force-refresh + retry. ENV 사용 중에는 retry 안 함.
//
// constructor 에서 process.env 1회 snapshot — 인스턴스 수명 동안 일관 (fp-monad.md 의 "전역 직접
// 참조 금지" 룰 준수, dispatch 경계에서만 env 진입).
class AdminTokenManager {
  #baseUrl
  #envToken

  constructor({ baseUrl, envToken }) {
    this.#baseUrl = baseUrl
    this.#envToken = envToken || null
  }

  // CLI dispatch 경계 진입점 — 한 번만 호출되어야 한다 (process.env snapshot 일관성).
  static fromEnv() {
    return new AdminTokenManager({
      baseUrl: resolveBaseUrl(),
      envToken: process.env.PRESENCE_ADMIN_TOKEN,
    })
  }

  async resolveToken() {
    if (this.#envToken) {
      this.#warnEnvShadowingFile()
      return this.#envToken
    }
    const session = this.#loadSessionOrThrow()
    if (!isAccessNearExpiry(session)) return session.accessToken
    return await this.#refresh(session)
  }

  async fetchAdminWithRetry(path, { method }) {
    let token = await this.resolveToken()
    let res = await this.#fetchAdmin(path, { method, token })
    if (res.status === 401 && !this.#envToken) {
      const session = loadAdminSession()
      if (!session) {
        throw new CliPolicyError([
          'policy: 인증 실패 (401). 세션이 없습니다.',
          '  npm run user -- admin login 으로 재로그인.',
        ].join('\n'))
      }
      token = await this.#refresh(session)
      res = await this.#fetchAdmin(path, { method, token })
      if (res.status === 401) {
        throw new CliPolicyError([
          'policy: 인증 실패 (refresh 후에도 401).',
          '  npm run user -- admin login 으로 재시도.',
          '  반복 발생 시 서버측 auth 상태 확인 (서버 로그/restart 검토 필요).',
        ].join('\n'))
      }
    }
    return res
  }

  // ENV 분기는 어떤 경우에도 파일 상태로 깨지지 않아야 함 (CI 호환).
  // 파일이 mode 위배 또는 손상이어도 ENV 흐름은 그대로 진행 — 경고는 best-effort.
  #warnEnvShadowingFile() {
    let fileExists = false
    try { fileExists = (loadAdminSession() != null) } catch (loadErr) { /* best-effort */ }
    if (fileExists) {
      console.warn('주의: PRESENCE_ADMIN_TOKEN env 가 admin-session.json 보다 우선 사용됩니다.')
      console.warn('  파일 기반 자동 동작을 원하면: unset PRESENCE_ADMIN_TOKEN')
    }
  }

  #loadSessionOrThrow() {
    let session
    try {
      session = loadAdminSession()
    } catch (err) {
      if (err instanceof AdminSessionError && err.reason === 'mode') {
        throw new CliPolicyError([
          `policy: admin-session.json 권한 위배 (${err.message}).`,
          '  chmod 600 ~/.presence/admin-session.json 후 재시도.',
        ].join('\n'))
      }
      if (err instanceof AdminSessionError && err.reason === 'corrupt') {
        throw new CliPolicyError([
          `policy: admin-session.json 손상 — ${err.message}`,
          '  npm run user -- admin login 으로 재로그인.',
        ].join('\n'))
      }
      throw err
    }
    if (!session) {
      throw new CliPolicyError([
        'policy: admin access token 필요.',
        '',
        '  로그인 — npm run user -- admin login',
        '  (이후 reload/version 은 ENV 없이 자동 동작)',
        '',
        '  CI/자동화 환경: PRESENCE_ADMIN_TOKEN env 사용 가능.',
        '    주의: process listing 으로 token 노출 가능.',
      ].join('\n'))
    }
    return session
  }

  async #refresh(session) {
    let res
    try {
      res = await httpJson(`${this.#baseUrl}${AUTH_PATHS.REFRESH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      })
    } catch (err) {
      throw mapHttpFetchError(err, CliPolicyError, 'policy')
    }
    if (res.status === 401) {
      clearAdminSession()
      throw new CliPolicyError([
        'policy: 세션 만료 (refresh token 무효).',
        '  npm run user -- admin login 으로 재로그인.',
      ].join('\n'))
    }
    if (!res.ok) {
      throw new CliPolicyError(`policy: refresh 실패 (HTTP ${res.status}).`)
    }
    if (!res.body.accessToken || !res.body.refreshToken) {
      throw new CliPolicyError([
        'policy: refresh 응답에 토큰이 누락되었습니다 (서버 응답 형식이 호환되지 않음).',
        '  npm run user -- admin login 으로 재로그인.',
      ].join('\n'))
    }
    saveAdminSession({
      username: session.username,
      accessToken: res.body.accessToken,
      refreshToken: res.body.refreshToken,
      accessExp: decodeAccessExp(res.body.accessToken),
    })
    return res.body.accessToken
  }

  async #fetchAdmin(path, { method = 'GET', token }) {
    try {
      return await httpJson(`${this.#baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      })
    } catch (err) {
      throw mapHttpFetchError(err, CliPolicyError, 'policy')
    }
  }
}

// FP-77: 401/403 분리 — 각 상황에 맞는 조치 안내. 401=token 자체 문제, 403=admin role 부재.
const handleAuthError = (response) => {
  if (response.status === 401) {
    throw new CliPolicyError([
      'policy: 인증이 필요합니다 (HTTP 401).',
      '  PRESENCE_ADMIN_TOKEN 이 올바른지 확인하거나 재로그인 후 token 을 갱신하세요.',
    ].join('\n'))
  }
  if (response.status === 403) {
    throw new CliPolicyError([
      'policy: admin 권한이 필요합니다 (HTTP 403).',
      '  현재 token 의 계정이 admin role 을 보유하고 있는지 확인하세요.',
      '  다른 계정으로 로그인하거나 admin 계정 token 을 사용하세요.',
    ].join('\n'))
  }
}

async function cmdPolicyLint({ file }) {
  const text = readFileSync(file, 'utf-8')
  const schemaText = readSchemaText()
  const result = await lintPolicyText({ text, schemaText })
  if (result.ok) {
    console.log(`OK: ${file}`)
    return
  }
  if (result.parseErrors.length > 0) {
    const lines = [`Parse error: ${file}`]
    for (const error of result.parseErrors) {
      lines.push(`  ${error.message ?? JSON.stringify(error)}`)
    }
    throw new CliPolicyError(lines.join('\n'))
  }
  if (result.schemaErrors.length > 0) {
    const lines = [`Schema mismatch: ${file}`]
    for (const error of result.schemaErrors) {
      const msg = error?.error?.message ?? error?.message ?? JSON.stringify(error)
      lines.push(`  ${msg}`)
    }
    throw new CliPolicyError(lines.join('\n'))
  }
}

function cmdPolicyList() {
  const files = listPolicyFiles()
  if (files.length === 0) {
    console.log('(no policies)')
    return
  }
  const widthName = Math.max(...files.map(file => file.filename.length), 'filename'.length)
  const widthCat = Math.max(...files.map(file => file.category.length), 'category'.length)
  console.log(`${'filename'.padEnd(widthName)}  ${'category'.padEnd(widthCat)}  size`)
  console.log(`${'-'.repeat(widthName)}  ${'-'.repeat(widthCat)}  ----`)
  for (const file of files) {
    console.log(`${file.filename.padEnd(widthName)}  ${file.category.padEnd(widthCat)}  ${file.size} B`)
  }
}

// KG-28 P5 — POST /api/admin/policy/reload 호출. 서버 측 hot reload 트리거.
// FP-76: 운영자 친화 출력. version + 시작/완료 시각 분리 + single-flight 동작 명시.
// FP-75: 실패 시 복구 단계 명시 — 정책 파일 수정 → lint → reload 흐름 안내.
async function cmdPolicyReload() {
  const manager = AdminTokenManager.fromEnv()
  const res = await manager.fetchAdminWithRetry(ADMIN_PATHS.POLICY_RELOAD, { method: 'POST' })
  handleAuthError(res)
  if (res.ok) {
    const body = res.body
    console.log('OK: 정책이 적용되었습니다.')
    console.log(`  버전: ${body.version}`)
    console.log(`  reload 시작: ${body.reloadStartedAt}`)
    console.log(`  적용 완료:   ${body.reloadedAt}`)
    console.log('')
    console.log('참고: 짧은 시간 내 여러 admin 이 동시에 reload 를 요청하면 한 번만 실행됩니다.')
    console.log('      "reload 시작" 시각이 이전 호출과 같으면 기존 reload 에 합류된 것입니다.')
    console.log('      새 reload 를 강제하려면 잠시 후 다시 실행하세요.')
    return
  }
  const body = res.body
  const lines = ['정책 reload 실패.', `원인: ${body.error}`, '']
  if (body.activeVersion != null) {
    lines.push(`현재 활성 정책은 그대로 유지됩니다 (버전 ${body.activeVersion}, 적용: ${body.activeReloadedAt}).`)
  }
  lines.push('디스크의 정책 파일은 변경되지 않았습니다.', '')
  lines.push('복구 방법:')
  lines.push('  1. 문제가 되는 .cedar 파일을 수정하거나 제거하세요')
  lines.push('  2. lint 로 검증하세요 — npm run user -- policy lint --file <파일>')
  lines.push('  3. 다시 reload 하세요   — npm run user -- policy reload')
  throw new CliPolicyError(lines.join('\n'))
}

// FP-74: GET /api/admin/policy/version CLI wrapper. 변경 적용 후 운영자가 활성 버전 재확인.
async function cmdPolicyVersion() {
  const manager = AdminTokenManager.fromEnv()
  const res = await manager.fetchAdminWithRetry(ADMIN_PATHS.POLICY_VERSION, { method: 'GET' })
  handleAuthError(res)
  if (!res.ok) {
    throw new CliPolicyError(`policy version 조회 실패: ${res.body?.error ?? `HTTP ${res.status}`}`)
  }
  console.log(`현재 활성 정책: 버전 ${res.body.version} (적용: ${res.body.reloadedAt})`)
}

export const dispatchPolicy = (action, flags) => dispatchWithCliErrorHandling(async () => {
  switch (action) {
    case 'lint':    return await cmdPolicyLint({ file: requireFlag(flags, 'file') })
    case 'list':    return cmdPolicyList()
    case 'reload':  return await cmdPolicyReload()
    case 'version': return await cmdPolicyVersion()
    default:
      throw new CliPolicyError(`Unknown policy action: ${action}\nActions: lint, list, reload, version`)
  }
})
