import { checkServer, loginToServer, changePasswordOnServer } from './http.js'
import { runRemote } from './remote.js'

// =============================================================================
// CLI 진입점 보조 함수들 (서버 URL 결정, 프롬프트, 인증 흐름)
// =============================================================================

// --server <url> → PRESENCE_SERVER env → default
const resolveServerUrl = () => {
  const argIdx = process.argv.indexOf('--server')
  if (argIdx !== -1 && process.argv[argIdx + 1]) return process.argv[argIdx + 1]
  const eqArg = process.argv.find(a => a.startsWith('--server='))
  if (eqArg) return eqArg.split('=')[1]
  if (process.env.PRESENCE_SERVER) return process.env.PRESENCE_SERVER
  return 'http://127.0.0.1:3000'
}

const promptInput = async (prompt) => {
  const { createInterface } = await import('node:readline')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()) })
  })
}

const promptPassword = async (prompt = 'Password: ') => {
  const { createInterface } = await import('node:readline')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const origWrite = rl._writeToOutput
    rl._writeToOutput = (s) => { origWrite.call(rl, s.includes(prompt) ? s : '*') }
    rl.question(prompt, (answer) => {
      rl._writeToOutput = origWrite
      rl.close()
      console.log()
      resolve(answer)
    })
  })
}

// mustChangePassword 흐름: 새 비밀번호 입력 → API 호출 → 새 토큰 반환. 3회 실패 시 exit.
const changePasswordFlow = async (baseUrl, username, currentPassword, authState) => {
  console.log(`\n[${username}] 최초 로그인입니다. 새 비밀번호를 설정하세요.`)
  for (let attempt = 0; attempt < 3; attempt++) {
    const newPassword = await promptPassword('새 비밀번호: ')
    const confirmPassword = await promptPassword('새 비밀번호 확인: ')
    if (newPassword !== confirmPassword) { console.error('비밀번호가 일치하지 않습니다. 다시 시도하세요.'); continue }
    if (!newPassword) { console.error('비밀번호를 입력하세요.'); continue }
    const res = await changePasswordOnServer(baseUrl, authState.accessToken, currentPassword, newPassword)
    if (res.status === 200) {
      console.log('비밀번호가 변경되었습니다.')
      return {
        accessToken: res.body.accessToken ?? authState.accessToken,
        refreshToken: res.body.refreshToken ?? authState.refreshToken,
      }
    }
    console.error(res.body?.error || '비밀번호 변경 실패')
  }
  console.error('비밀번호 변경에 실패했습니다.')
  process.exit(1)
}

// 로그인 루프 (최대 3회 시도) + mustChangePassword 후속 처리.
const loginFlow = async (baseUrl) => {
  const username = await promptInput('사용자명: ')
  for (let attempt = 0; attempt < 3; attempt++) {
    const password = await promptPassword('비밀번호: ')
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
    console.error(res.body?.error || '로그인 실패')
    if (attempt < 2) console.log('다시 시도하세요.')
  }
  console.error('로그인에 실패했습니다.')
  process.exit(1)
}

/**
 * TUI entry point: server URL 결정 → 서버 생존 확인 → 인증 → Ink UI 렌더.
 * @returns {Promise<void>}
 */
const main = async () => {
  const baseUrl = resolveServerUrl()

  const serverStatus = await checkServer(baseUrl)
  if (!serverStatus.reachable) {
    console.error(`서버에 연결할 수 없습니다: ${baseUrl}`)
    console.error('서버가 실행 중인지 확인하세요: npm start')
    process.exit(1)
  }

  const { authState, username } = serverStatus.authRequired
    ? await loginFlow(baseUrl)
    : { authState: null, username: null }

  return runRemote(baseUrl, { authState, username })
}

export { main }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1) })
}
