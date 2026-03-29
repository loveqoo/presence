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

  // CORS — cross-origin web client support (opt-in via CORS_ORIGIN env var)
  const corsOrigin = process.env.CORS_ORIGIN
  if (corsOrigin) {
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', corsOrigin)
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.header('Access-Control-Allow-Credentials', 'true')
      if (req.method === 'OPTIONS') return res.sendStatus(204)
      next()
    })
  }

  app.use(express.json())

  app.get('/api/instances', (_req, res) => {
    res.json(childManager.listStatus())
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
