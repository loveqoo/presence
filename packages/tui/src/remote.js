import { WS_CLOSE } from '@presence/core/core/policies.js'
import { defaultSessionId } from '@presence/infra/infra/constants.js'
import { initI18n } from '@presence/infra/i18n'
import { createTokenRefresher, createAuthClient } from './auth-client.js'
import { RemoteSession } from './remote-session.js'

// =============================================================================
// runRemote: 진입점. 인프라 생성 → RemoteSession → App 렌더.
// =============================================================================

async function runRemote(baseUrl, opts = {}) {
  const { authState, username } = opts
  const wsUrl = baseUrl.replace(/^http/, 'ws')

  const tryRefresh = createTokenRefresher(baseUrl, authState)
  const authFailedHolder = {
    handler() {
      console.error('인증이 만료되었습니다. 다시 로그인 해주세요.')
      process.exit(1)
    },
  }
  const client = createAuthClient(baseUrl, authState, tryRefresh, {
    onAuthFailed() { authFailedHolder.handler() },
  })

  const sessionId = defaultSessionId(username)
  const sessionBase = `/api/sessions/${sessionId}`
  const [initialTools, agents, config] = await Promise.all([
    client.getJson(`${sessionBase}/tools`).catch(() => []),
    client.getJson(`${sessionBase}/agents`).catch(() => []),
    client.getJson(`${sessionBase}/config`).catch(() => ({})),
  ])

  initI18n(config.locale || 'ko')

  let gitBranch = ''
  try {
    const { execSync } = await import('child_process')
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch (_) {}

  const session = new RemoteSession({
    wsUrl, authState, username, client,
    config, agents, gitBranch, initialTools, tryRefresh,
  })

  authFailedHolder.handler = function markDisconnected() { session.markDisconnected(WS_CLOSE.AUTH_FAILED) }

  function onSignal() { session.disconnect(); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const waitUntilExit = session.render()
  await waitUntilExit()

  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  session.disconnect()
}

export { runRemote }
