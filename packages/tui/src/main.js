import { initI18n, t } from '@presence/infra/i18n'
import { checkServer, loginToServer, changePasswordOnServer } from './http.js'
import { runRemote } from './remote.js'

// remote.js 의 `runRemote` 가 config.locale 받은 후 다시 init — main 의 인증 흐름은
// locale 결정 전이므로 ko 를 기본으로 미리 초기화. initI18n 은 idempotent.
initI18n('ko')

// =============================================================================
// CLI 진입점 보조 함수들 (서버 URL 결정, 프롬프트, 인증 흐름)
// =============================================================================

// --server <url> → PRESENCE_SERVER env → default
// 반환: { url, source: 'arg' | 'env' | 'default' }
const resolveServerUrl = (argv = process.argv, env = process.env) => {
  const argIdx = argv.indexOf('--server')
  if (argIdx !== -1 && argv[argIdx + 1]) return { url: argv[argIdx + 1], source: 'arg' }
  const eqArg = argv.find(a => a.startsWith('--server='))
  if (eqArg) return { url: eqArg.split('=')[1], source: 'arg' }
  if (env.PRESENCE_SERVER) return { url: env.PRESENCE_SERVER, source: 'env' }
  return { url: 'http://127.0.0.1:3000', source: 'default' }
}

const SERVER_URL_SOURCE_LABEL = Object.freeze({
  arg: '--server',
  env: 'PRESENCE_SERVER',
  default: '기본값',
})

const promptInput = async (prompt) => {
  const { createInterface } = await import('node:readline')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()) })
  })
}

// 비밀번호 입력: readline 의 _writeToOutput 을 오버라이드해 prompt 외에는 아무것도
// 에코하지 않는다. `*` 를 찍지 않으므로 길이가 노출되지 않고, backspace 잔류도
// 발생하지 않는다. 유저는 "타이핑해도 화면이 반응하지 않는" 전형적인 CLI 비밀번호
// 입력 UX 를 경험한다.
const promptPassword = async (prompt = 'Password: ') => {
  const { createInterface } = await import('node:readline')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const origWrite = rl._writeToOutput
    rl._writeToOutput = (s) => { if (s.includes(prompt)) origWrite.call(rl, s) }
    rl.question(prompt, (answer) => {
      rl._writeToOutput = origWrite
      rl.close()
      console.log()
      resolve(answer)
    })
  })
}

const MAX_AUTH_ATTEMPTS = 3

// 시도 잔여 표기. left=0 인 마지막 시도에는 라벨 없음 (null), left=1 은 "마지막 시도",
// 그 이상은 "{{left}}번 남음" — i18n auth.last_attempt / auth.attempts_remaining.
const remainingLabel = (attempt, max = MAX_AUTH_ATTEMPTS) => {
  const left = max - attempt - 1
  if (left <= 0) return null
  if (left === 1) return t('auth.last_attempt')
  return t('auth.attempts_remaining', { left })
}

// mustChangePassword 흐름: 새 비밀번호 입력 → API 호출 → 새 토큰 반환. 3회 실패 시 exit.
const changePasswordFlow = async (baseUrl, username, currentPassword, authState) => {
  console.log(t('auth.must_change_intro', { username }))
  for (let attempt = 0; attempt < MAX_AUTH_ATTEMPTS; attempt++) {
    const suffix = remainingLabel(attempt)
    const label = suffix ? t('auth.new_password_prompt_remaining', { suffix }) : t('auth.new_password_prompt')
    const newPassword = await promptPassword(label)
    const confirmPassword = await promptPassword(t('auth.new_password_confirm'))
    if (newPassword !== confirmPassword) { console.error(t('auth.password_mismatch')); continue }
    if (!newPassword) { console.error(t('auth.password_empty')); continue }
    const res = await changePasswordOnServer(baseUrl, authState.accessToken, currentPassword, newPassword)
    if (res.status === 200) {
      console.log(t('auth.password_changed'))
      return {
        accessToken: res.body.accessToken ?? authState.accessToken,
        refreshToken: res.body.refreshToken ?? authState.refreshToken,
      }
    }
    console.error(res.body?.error || t('auth.change_failed'))
  }
  console.error(t('auth.change_failed_total'))
  process.exit(1)
}

// 로그인 루프 (최대 3회 시도) + mustChangePassword 후속 처리.
const loginFlow = async (baseUrl) => {
  const username = await promptInput(t('auth.username_prompt'))
  for (let attempt = 0; attempt < MAX_AUTH_ATTEMPTS; attempt++) {
    const suffix = remainingLabel(attempt)
    const label = suffix ? t('auth.password_prompt_remaining', { suffix }) : t('auth.password_prompt')
    const password = await promptPassword(label)
    const res = await loginToServer(baseUrl, username, password)
    if (res.status === 200) {
      let authState = {
        accessToken: res.body.accessToken,
        refreshToken: res.body.refreshToken || null,
      }
      if (res.body.mustChangePassword) {
        authState = await changePasswordFlow(baseUrl, username, password, authState)
      }
      return { authState, username }
    }
    console.error(res.body?.error || t('auth.login_failed'))
  }
  console.error(t('auth.login_failed_total'))
  process.exit(1)
}

/**
 * TUI entry point: server URL 결정 → 서버 생존 확인 → 인증 → Ink UI 렌더.
 * @returns {Promise<void>}
 */
const main = async () => {
  const { url: baseUrl, source } = resolveServerUrl()
  console.log(`연결 중: ${baseUrl} [${SERVER_URL_SOURCE_LABEL[source]}]`)

  const serverStatus = await checkServer(baseUrl)
  if (!serverStatus.reachable) {
    const { code, message } = serverStatus.reason || {}
    const hint = code === 'ECONNREFUSED' ? '서버가 실행 중이 아닙니다. npm start 로 서버를 시작하세요.'
      : code === 'ETIMEDOUT' ? '응답 시간 초과. 네트워크 또는 방화벽을 확인하세요.'
      : code === 'ENOTFOUND' ? '호스트를 찾을 수 없습니다. --server URL 을 확인하세요.'
      : '서버 상태를 확인하세요: npm start'
    console.error(`서버에 연결할 수 없습니다: ${baseUrl}`)
    console.error(`원인: ${code || 'UNKNOWN'}${message ? ` (${message})` : ''}`)
    console.error(hint)
    process.exit(1)
  }

  // 서버는 authEnabled=true 고정 — 인증 필수
  const { authState, username } = await loginFlow(baseUrl)

  console.log('세션을 초기화하는 중...')
  return runRemote(baseUrl, { authState, username })
}

export { main, resolveServerUrl, remainingLabel, SERVER_URL_SOURCE_LABEL }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1) })
}
