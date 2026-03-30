import React from 'react'
import { render } from 'ink'
import { createGlobalContext } from '@presence/infra/infra/global-context.js'
import { createRemoteState } from '@presence/infra/infra/remote-state.js'
import { createSession } from '@presence/infra/infra/session-factory.js'
import { App } from './ui/App.js'

const h = React.createElement

// =============================================================================
// Bootstrap: createGlobalContext + createSession 조합. 하위 호환 유지.
// e2e 테스트에서 직접 사용 가능: const app = await bootstrap(config)
// =============================================================================

/**
 * Bootstrap a standalone (local) Presence session without a remote server.
 * Creates global context and a session, then returns handles for testing and programmatic use.
 * @param {object} configOverride - Config overrides merged on top of defaults.
 * @param {{persistenceCwd?: string}} [options]
 * @returns {Promise<{agent: object, state: object, config: object, handleInput: Function, shutdown: Function}>}
 */
const bootstrap = async (configOverride, { persistenceCwd } = {}) => {
  const globalCtx = await createGlobalContext(configOverride)
  const session = createSession(globalCtx, { persistenceCwd })

  const { config, logger, personaConfig, memory, llm, mcpControl, jobStore, embedder, mcpConnections, mem0 } = globalCtx
  const { agent, state, tools, agents, handleInput, handleApproveResponse, handleCancel, schedulerActor, delegateActor } = session

  // --- Startup summary ---
  logger.info('Startup complete', {
    model: config.llm.model,
    responseFormat: config.llm.responseFormat,
    maxRetries: config.llm.maxRetries,
    maxIterations: config.maxIterations,
    timeoutMs: config.llm.timeoutMs,
    tools: tools.length,
    agents: agents.length,
    mcpServers: mcpConnections.length,
    embedder: embedder ? config.embed.provider : 'none',
    scheduler: config.scheduler.enabled ? `enabled (poll: ${config.scheduler.pollIntervalMs}ms)` : 'disabled',
    scheduledJobs: jobStore.listJobs().filter(j => j.enabled).length,
    memory: mem0 ? `mem0 (${memory?.allNodes().length ?? 0} cached)` : 'disabled',
  })

  const shutdown = async () => {
    await session.shutdown()
    await globalCtx.shutdown()
  }

  return {
    agent, state, config, logger,
    tools, agents, personaConfig,
    handleInput, handleApproveResponse, handleCancel,
    schedulerActor, delegateActor, jobStore,
    memory, llm, mcpControl,
    shutdown,
  }
}

// =============================================================================
// View: Ink 렌더링. TTY 필요.
//
// --server <url> 또는 PRESENCE_SERVER 환경변수로 서버 URL 지정.
// =============================================================================

// --- 서버 URL 결정: --server <url> → PRESENCE_SERVER env → default ---
const resolveServerUrl = () => {
  const argIdx = process.argv.indexOf('--server')
  if (argIdx !== -1 && process.argv[argIdx + 1]) return process.argv[argIdx + 1]
  const eqArg = process.argv.find(a => a.startsWith('--server='))
  if (eqArg) return eqArg.split('=')[1]
  if (process.env.PRESENCE_SERVER) return process.env.PRESENCE_SERVER
  return 'http://127.0.0.1:3000'
}

// 텍스트 입력 프롬프트 (readline)
const promptInput = async (prompt) => {
  const { createInterface } = await import('node:readline')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// 서버 생존 여부 + authRequired 확인
const checkServer = async (baseUrl) => {
  try {
    const { default: http } = await import('node:http')
    const url = new URL('/api/instance', baseUrl)
    return await new Promise((resolve) => {
      const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        let buf = ''
        res.on('data', d => { buf += d })
        res.on('end', () => {
          try {
            const body = JSON.parse(buf)
            resolve({ reachable: true, authRequired: !!body.authRequired })
          } catch {
            resolve({ reachable: res.statusCode === 200, authRequired: false })
          }
        })
      })
      req.on('error', () => resolve({ reachable: false, authRequired: false }))
      req.setTimeout(1500, () => { req.destroy(); resolve({ reachable: false, authRequired: false }) })
    })
  } catch (_) {
    return { reachable: false, authRequired: false }
  }
}

// 비밀번호 프롬프트 (마스킹)
const promptPassword = async (prompt = 'Password: ') => {
  const { createInterface } = await import('node:readline')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const origWrite = rl._writeToOutput
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) origWrite.call(rl, s)
      else origWrite.call(rl, '*')
    }
    rl.question(prompt, (answer) => {
      rl._writeToOutput = origWrite
      rl.close()
      console.log()
      resolve(answer)
    })
  })
}

// 로그인 API 호출
const loginToServer = async (baseUrl, username, password) => {
  const { default: http } = await import('node:http')
  const url = new URL('/api/auth/login', baseUrl)
  const data = JSON.stringify({ username, password })
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
        catch { resolve({ status: res.statusCode, body: buf }) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// 비밀번호 변경 API 호출
const changePasswordOnServer = async (baseUrl, accessToken, currentPassword, newPassword) => {
  const { default: http } = await import('node:http')
  const url = new URL('/api/auth/change-password', baseUrl)
  const data = JSON.stringify({ currentPassword, newPassword })
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${accessToken}`,
      },
    }, (res) => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
        catch { resolve({ status: res.statusCode, body: buf }) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// Refresh token으로 새 access token 획득
const refreshAccessToken = async (baseUrl, refreshToken) => {
  const { default: http } = await import('node:http')
  const url = new URL('/api/auth/refresh', baseUrl)
  const data = JSON.stringify({ refreshToken })
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
        catch { resolve({ status: res.statusCode, body: buf }) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// mustChangePassword 흐름: 새 비밀번호 입력 → API 호출 → 새 토큰 반환
const changePasswordFlow = async (baseUrl, username, currentPassword, authState) => {
  console.log(`\n[${username}] 최초 로그인입니다. 새 비밀번호를 설정하세요.`)
  for (let attempt = 0; attempt < 3; attempt++) {
    const newPassword = await promptPassword('새 비밀번호: ')
    const confirmPassword = await promptPassword('새 비밀번호 확인: ')
    if (newPassword !== confirmPassword) {
      console.error('비밀번호가 일치하지 않습니다. 다시 시도하세요.')
      continue
    }
    if (!newPassword) {
      console.error('비밀번호를 입력하세요.')
      continue
    }
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

// 원격 모드: WS 상태 미러링 + REST 커맨드
const runRemote = async (baseUrl, { authState, username } = {}) => {
  const wsUrl = baseUrl.replace(/^http/, 'ws')

  // --- 401 자동 갱신 (단일 refreshPromise 동시성 제어) ---
  let refreshPromise = null

  const tryRefresh = async () => {
    if (!authState) return false
    if (refreshPromise) return refreshPromise

    refreshPromise = (async () => {
      try {
        const res = await refreshAccessToken(baseUrl, authState.refreshToken)
        if (res.status === 200) {
          authState.accessToken = res.body.accessToken
          if (res.body.refreshToken) authState.refreshToken = res.body.refreshToken
          return true
        }
      } catch {}
      return false
    })()

    const result = await refreshPromise
    refreshPromise = null
    return result
  }

  // --- HTTP 헬퍼 ---
  const rawHttpRequest = async (method, path, body) => {
    const { default: http } = await import('node:http')
    const url = new URL(path, baseUrl)
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null
      const authHeader = authState?.accessToken ? { 'Authorization': `Bearer ${authState.accessToken}` } : {}
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...authHeader,
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let buf = ''
        res.on('data', d => { buf += d })
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) } catch { resolve({ status: res.statusCode, body: buf }) } })
      })
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  }

  // 401 자동 갱신 래퍼
  const httpRequest = async (method, path, body) => {
    const res = await rawHttpRequest(method, path, body)
    if (res.status === 401 && authState) {
      const refreshed = await tryRefresh()
      if (refreshed) {
        const retry = await rawHttpRequest(method, path, body)
        return retry.body
      }
    }
    return res.body
  }

  const post = (path, body) => httpRequest('POST', path, body)
  const httpDelete = (path) => httpRequest('DELETE', path)
  const getJson = async (path) => {
    const result = await httpRequest('GET', path)
    return result ?? []
  }

  // --- 세션 관리 API ---
  const onListSessions = () => getJson('/api/sessions')
  const onCreateSession = (id) => post('/api/sessions', { id, type: 'user' })
  const onDeleteSession = (id) => httpDelete(`/api/sessions/${id}`)

  // --- 세션 상태 (mutable) ---
  let currentSessionId = username ? `${username}-default` : 'user-default'
  const wsHeaders = authState?.accessToken ? { 'Authorization': `Bearer ${authState.accessToken}` } : undefined
  let remoteState = createRemoteState({ wsUrl, sessionId: currentSessionId, headers: wsHeaders })
  let currentTools = []
  let rerender = null

  const [initialTools, agents, config] = await Promise.all([
    getJson('/api/tools').catch(() => []),
    getJson('/api/agents').catch(() => []),
    getJson('/api/config').catch(() => ({})),
  ])
  currentTools = initialTools

  const cwd = process.cwd()
  let gitBranch = ''
  try {
    const { execSync } = await import('child_process')
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch (_) {}

  // --- 세션별 핸들러 빌더 ---
  const buildHandlers = (sessionId) => {
    const apiBase = `/api/sessions/${sessionId}`
    return {
      handleInput: async (input) => {
        const res = await post(`${apiBase}/chat`, { input })
        if (res.type === 'error') throw new Error(res.content)
        return res.content
      },
      handleApproveResponse: (approved) => { post(`${apiBase}/approve`, { approved }).catch(() => {}) },
      handleCancel: () => { post(`${apiBase}/cancel`).catch(() => {}) },
    }
  }

  // --- App props 빌더 ---
  const buildAppProps = () => {
    const { handleInput, handleApproveResponse, handleCancel } = buildHandlers(currentSessionId)
    return {
      key: currentSessionId,   // 세션 전환 시 App 완전 재마운트 → 메시지 초기화
      state: remoteState,
      onInput: handleInput,
      onApprove: handleApproveResponse,
      onCancel: handleCancel,
      agentName: config.persona?.name || 'Presence',
      tools: currentTools,
      agents,
      cwd,
      gitBranch,
      model: config.llm?.model || '',
      config,
      memory: null,
      llm: null,
      mcpControl: null,
      initialMessages: [],
      sessionId: currentSessionId,
      onListSessions,
      onCreateSession,
      onDeleteSession,
      onSwitchSession,
    }
  }

  // --- 세션 전환 ---
  const onSwitchSession = async (newId) => {
    remoteState.disconnect()
    currentSessionId = newId
    const newWsHeaders = authState?.accessToken ? { 'Authorization': `Bearer ${authState.accessToken}` } : undefined
    remoteState = createRemoteState({ wsUrl, sessionId: newId, headers: newWsHeaders })
    const defaultSessionId = username ? `${username}-default` : 'user-default'
    const toolsPath = newId === defaultSessionId ? '/api/tools' : `/api/sessions/${newId}/tools`
    currentTools = await getJson(toolsPath).catch(() => currentTools)
    if (rerender) rerender(h(App, buildAppProps()))
  }

  const onSignal = () => { remoteState.disconnect(); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const rendered = render(h(App, buildAppProps()))
  rerender = rendered.rerender
  const { waitUntilExit } = rendered

  await waitUntilExit()
  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  remoteState.disconnect()
}


/**
 * TUI entry point: resolves server URL from --server CLI arg or PRESENCE_SERVER env,
 * checks server reachability, authenticates if required (with mustChangePassword support),
 * then renders the Ink UI over a remote WebSocket connection.
 * @returns {Promise<void>}
 */
const main = async () => {
  const baseUrl = resolveServerUrl()

  // --- 서버 생존 여부 확인 ---
  const serverStatus = await checkServer(baseUrl)
  if (!serverStatus.reachable) {
    console.error(`서버에 연결할 수 없습니다: ${baseUrl}`)
    console.error('서버가 실행 중인지 확인하세요: npm start')
    process.exit(1)
  }

  // --- 인증 ---
  let authState = null
  let username = null
  if (serverStatus.authRequired) {
    username = await promptInput('사용자명: ')
    const maxAttempts = 3
    let lastPassword = null
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const password = await promptPassword('비밀번호: ')
      const res = await loginToServer(baseUrl, username, password)
      if (res.status === 200) {
        authState = {
          accessToken: res.body.accessToken,
          refreshToken: res.body.refreshToken || null,
        }
        lastPassword = password
        // mustChangePassword 처리
        if (res.body.mustChangePassword) {
          authState = await changePasswordFlow(baseUrl, username, lastPassword, authState)
        }
        break
      }
      console.error(res.body?.error || '로그인 실패')
      if (attempt < maxAttempts - 1) console.log('다시 시도하세요.')
    }
    if (!authState) {
      console.error('로그인에 실패했습니다.')
      process.exit(1)
    }
  }

  return runRemote(baseUrl, { authState, username })
}

export { main, bootstrap, createGlobalContext, createSession }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1) })
}
