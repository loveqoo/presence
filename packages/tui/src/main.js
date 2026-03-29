import React from 'react'
import { render } from 'ink'
import { createGlobalContext } from '@presence/infra/infra/global-context.js'
import { createRemoteState } from '@presence/infra/infra/remote-state.js'
import { createSession } from '@presence/infra/infra/session-factory.js'
import { loadClientConfig } from '@presence/infra/infra/config.js'
import fp from '@presence/core/lib/fun-fp.js'
const { Either } = fp
import { App } from './ui/App.js'

const h = React.createElement

// =============================================================================
// Bootstrap: createGlobalContext + createSession 조합. 하위 호환 유지.
// e2e 테스트에서 직접 사용 가능: const app = await bootstrap(config)
// =============================================================================

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
// ~/.presence/clients/{userId}.json 에서 서버 URL을 읽어 원격 접속.
// 서버 미응답 시 오케스트레이터 자동 spawn 시도.
// =============================================================================

// --- 클라이언트 설정 로드 ---

const resolveUserId = () => {
  // --instance anthony 또는 --instance=anthony
  const eqIdx = process.argv.indexOf('--instance')
  if (eqIdx !== -1 && process.argv[eqIdx + 1]) return process.argv[eqIdx + 1]
  const eqArg = process.argv.find(a => a.startsWith('--instance='))
  if (eqArg) return eqArg.split('=')[1]
  return null
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

// 서버가 응답할 때까지 폴링 (최대 10초)
const waitForServer = async (baseUrl, { maxMs = 10_000, intervalMs = 300 } = {}) => {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const { reachable } = await checkServer(baseUrl)
    if (reachable) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

// 오케스트레이터 프로세스 백그라운드 spawn (터미널 종료 후에도 유지)
const spawnOrchestrator = async () => {
  const { spawn } = await import('node:child_process')
  const { createRequire } = await import('node:module')
  const orchestratorPath = createRequire(import.meta.url).resolve('@presence/orchestrator')
  const child = spawn(process.execPath, [orchestratorPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  })
  child.unref()
}

// 원격 모드: WS 상태 미러링 + REST 커맨드
const runRemote = async (baseUrl, { authState } = {}) => {
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
  let currentSessionId = 'user-default'
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
    const toolsPath = newId === 'user-default' ? '/api/tools' : `/api/sessions/${newId}/tools`
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


const main = async () => {
  const userId = resolveUserId()

  if (!userId) {
    console.error('사용법: npm run start:cli -- --instance <user-id>')
    console.error('예시:   npm run start:cli -- --instance anthony')
    process.exit(1)
  }

  const clientConfig = Either.fold(
    err => {
      console.error(`클라이언트 설정을 찾을 수 없습니다: ${err}`)
      console.error(`~/.presence/clients/${userId}.json 파일을 생성하세요.`)
      console.error(`예시: { "instanceId": "${userId}", "server": { "url": "http://127.0.0.1:3001" } }`)
      process.exit(1)
    },
    config => config,
    loadClientConfig(userId),
  )

  const baseUrl = clientConfig.server.url

  const serverStatus = await checkServer(baseUrl)
  if (!serverStatus.reachable) {
    console.log(`서버에 연결할 수 없습니다: ${baseUrl}`)
    console.log('오케스트레이터를 시작합니다...')
    await spawnOrchestrator()
    const ready = await waitForServer(baseUrl)
    if (!ready) {
      console.error('서버 시작 실패. 오케스트레이터를 수동으로 시작하세요: npm start')
      process.exit(1)
    }
    // 재확인
    const recheckStatus = await checkServer(baseUrl)
    serverStatus.authRequired = recheckStatus.authRequired
  }

  // --- 인증 ---
  let authState = null
  if (serverStatus.authRequired) {
    console.log(`인스턴스 [${userId}]에 로그인합니다.`)
    const maxAttempts = 3
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const password = await promptPassword('Password: ')
      const res = await loginToServer(baseUrl, userId, password)
      if (res.status === 200) {
        authState = {
          accessToken: res.body.accessToken,
          refreshToken: res.body.refreshToken || null,
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

  return runRemote(baseUrl, { authState })
}

export { main, bootstrap, createGlobalContext, createSession }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1) })
}
