import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import fp from '@presence/core/lib/fun-fp.js'
import { Config } from '@presence/infra/infra/config.js'

const { Reader } = fp

// =============================================================================
// 서버 유틸리티: CORS 미들웨어, 시작 요약 로그, 정적 웹 UI 마운트
// =============================================================================

// CORS — localhost cross-origin 허용.
const corsMiddleware = (req, res, next) => {
  const origin = req.headers.origin
  if (origin) {
    try {
      const hostname = new URL(origin).hostname
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        res.header('Access-Control-Allow-Origin', origin)
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        res.header('Access-Control-Allow-Credentials', 'true')
      }
    } catch {}
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
}

const mountStaticWebUi = (expressApp) => {
  try {
    const webDist = join(import.meta.dirname, '../../../web/dist')
    if (!existsSync(webDist)) return false
    expressApp.use(express.static(webDist))
    expressApp.get('/{*splat}', (_req, res) => res.sendFile(join(webDist, 'index.html')))
    return true
  } catch (_) {
    return false
  }
}

// Reader 기반 시작 요약 로그
// Reader 기반 시작 요약 로그
// env: { server: { username, host, port }, infra: { config, memory, defaultSession, userContext } }
const logStartupSummaryR = Reader.asks(({ server, infra }) => {
  const { username, host, port } = server
  const { config, memory, defaultSession, userContext } = infra
  const toolCount = defaultSession.tools.length
  const agentCount = userContext.agentRegistry.list().length
  const jobCount = userContext.jobStore.listJobs().filter(job => job.enabled).length
  const hasWebUI = existsSync(join(import.meta.dirname, '../../../web/dist'))

  console.log(`\nPresence server ready`)
  if (username || process.env.PRESENCE_INSTANCE_ID) console.log(`  User       : ${username || process.env.PRESENCE_INSTANCE_ID}`)
  console.log(`  URL        : http://${host}:${port}`)
  console.log(`  WebSocket  : ws://${host}:${port}`)
  console.log(`  Model      : ${config.llm.model}`)
  console.log(`  Memory     : ${memory ? 'mem0 enabled' : 'disabled'}`)
  console.log(`  Tools      : ${toolCount}`)
  console.log(`  Agents     : ${agentCount}`)
  if (userContext.mcpConnections.length > 0) console.log(`  MCP        : ${userContext.mcpConnections.length} server(s)`)
  console.log(`  Scheduler  : ${config.scheduler.enabled ? `enabled (${jobCount} active jobs)` : 'disabled'}`)
  if (hasWebUI) console.log(`  Web UI     : http://${host}:${port}`)
  console.log(`\n  CLI client : npm run start:cli`)
  console.log(`  Logs       : ~/.presence/logs/agent.log\n`)
})

// KG-06: PRESENCE_DIR 변경 시 이전 경로 데이터 경고
const warnPresenceDirChange = () => {
  const defaultDir = Config.defaultPresenceDir()
  const currentDir = Config.presenceDir()
  if (currentDir !== defaultDir && existsSync(join(defaultDir, 'users.json'))) {
    console.warn(`PRESENCE_DIR changed: ${defaultDir} -> ${currentDir}`)
    console.warn('  Migrate data manually if needed.')
  }
}

// Promise 유틸: close/listen 콜백을 Promise로 래핑
const closeAsync = (closeable) => new Promise(resolve => closeable.close(resolve))
const listenAsync = (server, port, host) => new Promise(resolve => server.listen(port, host, resolve))

export { corsMiddleware, mountStaticWebUi, logStartupSummaryR, warnPresenceDirChange, closeAsync, listenAsync }
