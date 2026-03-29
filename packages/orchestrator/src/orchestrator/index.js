import express from 'express'
import { createServer } from 'http'
import { loadInstancesFile } from '@presence/infra/infra/config.js'
import fp from '@presence/core/lib/fun-fp.js'
const { Either } = fp
import { createChildManager } from './child-manager.js'

// =============================================================================
// Orchestrator: instances.json 읽기 → N개 서버 fork → 관리 API
// =============================================================================

/**
 * Start the orchestrator: reads instances.json, forks enabled+autoStart instances, and exposes a management API.
 * @param {{presenceDir?: string}} [options] - Optional override for the ~/.presence directory path.
 * @returns {Promise<{server: import('http').Server, childManager: object, shutdown: Function}>}
 */
const startOrchestrator = async ({ presenceDir } = {}) => {
  const instancesFile = Either.fold(
    err => { throw new Error(err) },
    data => data,
    loadInstancesFile(presenceDir),
  )
  const { orchestrator: orchConfig, instances } = instancesFile

  const logger = {
    info: (...args) => console.log('[orchestrator]', ...args),
    warn: (...args) => console.warn('[orchestrator]', ...args),
    error: (...args) => console.error('[orchestrator]', ...args),
  }

  const resolvedDir = presenceDir || process.env.PRESENCE_DIR
  const childManager = createChildManager({ logger, presenceDir: resolvedDir })

  // autoStart 인스턴스 fork
  const autoStartInstances = instances.filter(i => i.enabled && i.autoStart)
  for (const def of autoStartInstances) {
    logger.info(`Starting instance: ${def.id} on ${def.host}:${def.port}`)
    childManager.forkInstance(def)
  }

  // 관리 API
  const app = express()

  // CORS — localhost 간 cross-origin 기본 허용
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin) {
      try {
        const h = new URL(origin).hostname
        if (h === 'localhost' || h === '127.0.0.1') {
          res.header('Access-Control-Allow-Origin', origin)
          res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
          res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
          res.header('Access-Control-Allow-Credentials', 'true')
        }
      } catch {}
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  app.use(express.json())

  app.get('/api/instances', async (_req, res) => {
    const statuses = childManager.listStatus()
    const enriched = await Promise.all(statuses.map(async (inst) => {
      if (inst.status !== 'running') return { ...inst, username: null }
      const url = `http://${inst.host === '0.0.0.0' ? '127.0.0.1' : inst.host}:${inst.port}`
      try {
        const r = await fetch(`${url}/api/auth/status`)
        if (r.ok) {
          const data = await r.json()
          return { ...inst, username: data.username }
        }
      } catch {}
      return { ...inst, username: null }
    }))
    res.json(enriched)
  })

  // 로그인 프록시 — instanceId로 인스턴스 특정, username = instanceId
  app.post('/api/auth/login', async (req, res) => {
    const { instanceId, password } = req.body || {}
    if (!password) return res.status(400).json({ error: 'password required' })

    const running = childManager.listStatus().filter(s => s.status === 'running')
    let target = instanceId
      ? running.find(s => s.id === instanceId)
      : running.length === 1 ? running[0] : null

    if (!target) return res.status(400).json({ error: 'Instance not found or ambiguous' })

    const url = `http://${target.host === '0.0.0.0' ? '127.0.0.1' : target.host}:${target.port}`

    // 인스턴스의 실제 username 조회
    let username = target.id
    try {
      const statusRes = await fetch(`${url}/api/auth/status`)
      if (statusRes.ok) {
        const statusData = await statusRes.json()
        if (statusData.username) username = statusData.username
      }
    } catch {}

    try {
      const r = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (r.ok) {
        const data = await r.json()
        return res.json({ ...data, instanceId: target.id, instanceUrl: url })
      }
      const errData = await r.json().catch(() => ({}))
      return res.status(r.status).json({ error: errData.error || 'Invalid credentials' })
    } catch {
      res.status(502).json({ error: 'Failed to reach instance' })
    }
  })

  app.post('/api/instances/:id/start', (req, res) => {
    const def = instances.find(i => i.id === req.params.id)
    if (!def) return res.status(404).json({ error: `Instance not found: ${req.params.id}` })
    if (!def.enabled) return res.status(400).json({ error: `Instance disabled: ${req.params.id}` })
    childManager.forkInstance(def)
    res.json({ ok: true, id: def.id })
  })

  app.post('/api/instances/:id/stop', async (req, res) => {
    const status = childManager.getStatus(req.params.id)
    if (!status) return res.status(404).json({ error: `Instance not found: ${req.params.id}` })
    await childManager.stopInstance(req.params.id)
    res.json({ ok: true, id: req.params.id })
  })

  app.post('/api/instances/:id/restart', async (req, res) => {
    const def = instances.find(i => i.id === req.params.id)
    if (!def) return res.status(404).json({ error: `Instance not found: ${req.params.id}` })
    await childManager.restartInstance(req.params.id)
    res.json({ ok: true, id: req.params.id })
  })

  const server = createServer(app)
  const { port, host } = orchConfig

  await new Promise(resolve => server.listen(port, host, resolve))

  logger.info(`Orchestrator ready on http://${host}:${port}`)
  logger.info(`  Instances: ${autoStartInstances.length} auto-started of ${instances.length} defined`)
  logger.info(`  Management API: http://${host}:${port}/api/instances`)

  // Graceful shutdown
  const shutdown = async () => {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    logger.info('Shutting down all instances...')
    await childManager.shutdownAll()
    await new Promise(r => server.close(r))
    logger.info('Orchestrator stopped')
  }
  const onSignal = async () => { await shutdown(); process.exit(0) }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  return { server, childManager, shutdown }
}

export { startOrchestrator }

// CLI 실행
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  startOrchestrator().catch(err => {
    console.error(`Failed to start orchestrator: ${err.message}`)
    process.exit(1)
  })
}
