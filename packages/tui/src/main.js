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
// 실행 모드:
//   기본값 : WS 서버 연결 시도 → 없으면 자동 spawn → 원격 상태로 렌더링
//   --local : in-process bootstrap() 모드 (테스트/오프라인 개발용)
// =============================================================================

const getServerPort = () => Number(process.env.PORT) || 3000

// 서버 생존 여부 확인 (GET /api/state 응답 체크)
const checkServerReachable = async (baseUrl) => {
  try {
    const { default: http } = await import('node:http')
    const url = new URL('/api/state', baseUrl)
    return await new Promise((resolve) => {
      const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(1500, () => { req.destroy(); resolve(false) })
    })
  } catch (_) {
    return false
  }
}

// 서버가 응답할 때까지 폴링 (최대 10초)
const waitForServer = async (baseUrl, { maxMs = 10_000, intervalMs = 300 } = {}) => {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await checkServerReachable(baseUrl)) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

// 서버 프로세스 백그라운드 spawn (터미널 종료 후에도 유지)
const spawnServer = async (port) => {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { join, dirname } = await import('node:path')
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'server/index.js')
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port) },
  })
  child.unref()
}

// 원격 모드: WS 상태 미러링 + REST 커맨드
const runRemote = async (baseUrl) => {
  const port = getServerPort()
  const wsUrl = baseUrl.replace(/^http/, 'ws')

  const remoteState = createRemoteState({ wsUrl, sessionId: 'user-default' })

  const post = async (path, body) => {
    const { default: http } = await import('node:http')
    const url = new URL(path, baseUrl)
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body || {})
      const req = http.request({
        hostname: url.hostname, port: url.port, path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        let buf = ''
        res.on('data', d => { buf += d })
        res.on('end', () => { try { resolve(JSON.parse(buf)) } catch { resolve(buf) } })
      })
      req.on('error', reject)
      req.write(data)
      req.end()
    })
  }

  const getJson = async (path) => {
    const { default: http } = await import('node:http')
    const url = new URL(path, baseUrl)
    return new Promise((resolve, reject) => {
      http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        let buf = ''
        res.on('data', d => { buf += d })
        res.on('end', () => { try { resolve(JSON.parse(buf)) } catch { resolve([]) } })
      }).on('error', reject)
    })
  }

  const handleInput = async (input) => {
    const res = await post('/api/chat', { input })
    if (res.type === 'error') throw new Error(res.content)
    return res.content
  }
  const handleApproveResponse = (approved) => { post('/api/approve', { approved }).catch(() => {}) }
  const handleCancel = () => { post('/api/cancel').catch(() => {}) }

  const [tools, agents, config] = await Promise.all([
    getJson('/api/tools').catch(() => []),
    getJson('/api/agents').catch(() => []),
    getJson('/api/config').catch(() => ({})),
  ])

  const cwd = process.cwd()
  let gitBranch = ''
  try {
    const { execSync } = await import('child_process')
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch (_) {}

  const onSignal = () => { remoteState.disconnect(); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const { waitUntilExit } = render(
    h(App, {
      state: remoteState,
      onInput: handleInput,
      onApprove: handleApproveResponse,
      onCancel: handleCancel,
      agentName: config.persona?.name || 'Presence',
      tools,
      agents,
      cwd,
      gitBranch,
      model: config.llm?.model || '',
      config,
      memory: null,   // remote mode: /memory 커맨드는 서버에서 처리
      llm: null,      // remote mode: /models 커맨드 비활성
      mcpControl: null, // remote mode: /mcp 커맨드는 서버에서 처리
      initialMessages: [],
    })
  )

  await waitUntilExit()
  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  remoteState.disconnect()
}

// in-process 모드: bootstrap() 후 직접 렌더링
const runLocal = async () => {
  const app = await bootstrap()

  const onSignal = async () => { await app.shutdown().catch(() => {}); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  const cwd = process.cwd()
  let gitBranch = ''
  try {
    const { execSync } = await import('child_process')
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()
  } catch (_) {}

  const { waitUntilExit } = render(
    h(App, {
      state: app.state,
      onInput: app.handleInput,
      onApprove: app.handleApproveResponse,
      onCancel: app.handleCancel,
      agentName: app.personaConfig.name,
      tools: app.tools,
      agents: app.agents,
      cwd,
      gitBranch,
      model: app.config.llm.model,
      config: app.config,
      memory: app.memory,
      llm: app.llm,
      mcpControl: app.mcpControl,
      initialMessages: [],
    })
  )

  if (app.config.scheduler.enabled) app.schedulerActor.send({ type: 'start' }).fork(() => {}, () => {})
  app.delegateActor.send({ type: 'start' }).fork(() => {}, () => {})

  await waitUntilExit()
  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
  await app.shutdown()
}

const main = async () => {
  const isLocal = process.argv.includes('--local')

  if (isLocal) {
    return runLocal()
  }

  // 원격 모드: 서버 자동 감지 + 필요 시 spawn
  const port = getServerPort()
  const baseUrl = `http://127.0.0.1:${port}`

  const reachable = await checkServerReachable(baseUrl)
  if (!reachable) {
    console.log(`서버가 실행 중이지 않습니다. 시작 중... (port ${port})`)
    await spawnServer(port)
    const ready = await waitForServer(baseUrl)
    if (!ready) {
      console.error('서버 시작 실패. --local 플래그로 in-process 모드로 실행하거나 서버를 수동으로 시작하세요.')
      process.exit(1)
    }
  }

  return runRemote(baseUrl)
}

export { main, bootstrap, createGlobalContext, createSession }

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1) })
}
