import { fork } from 'child_process'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

// =============================================================================
// ChildManager: 인스턴스별 자식 프로세스 fork, 감시, 재시작
// =============================================================================

const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000
const HEALTH_CHECK_INTERVAL_MS = 30_000
const HEALTH_CHECK_TIMEOUT_MS = 5_000

/**
 * Resolve the absolute path to the server entry point (`packages/server/src/server/index.js`).
 * @returns {string}
 */
const serverEntryPath = () => {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '../../../server/src/server/index.js')
}

/**
 * Create a child process manager that forks, monitors, and restarts server instances.
 * Supports exponential-backoff auto-restart (max 3 restarts per 60 s) and periodic health checks.
 * @param {{logger: object, presenceDir?: string}} deps
 * @returns {{forkInstance: Function, stopInstance: Function, restartInstance: Function, getStatus: Function, listStatus: Function, shutdownAll: Function}}
 */
const createChildManager = ({ logger, presenceDir }) => {
  const children = new Map() // id → { process, def, status, restarts, healthTimer }

  const forkInstance = (def) => {
    const { id, port, host = '127.0.0.1' } = def
    const env = {
      ...process.env,
      PRESENCE_INSTANCE_ID: id,
      PORT: String(port),
      HOST: host,
      ...(presenceDir ? { PRESENCE_DIR: presenceDir } : {}),
    }

    const child = fork(serverEntryPath(), [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })

    const entry = {
      process: child,
      def,
      status: 'starting',
      restarts: [],
      healthTimer: null,
    }

    child.stdout.on('data', (data) => {
      const lines = data.toString().trim()
      if (lines) logger.info(`[${id}] ${lines}`)
    })

    child.stderr.on('data', (data) => {
      const lines = data.toString().trim()
      if (lines) logger.error(`[${id}] ${lines}`)
    })

    child.on('message', (msg) => {
      if (msg === 'ready') {
        entry.status = 'running'
        logger.info(`[${id}] Instance running on ${host}:${port}`)
        startHealthCheck(id)
      }
    })

    child.on('exit', (code, signal) => {
      entry.status = 'stopped'
      clearHealthTimer(id)

      if (code !== 0 && code !== null) {
        logger.warn(`[${id}] Exited with code ${code} (signal: ${signal})`)
        attemptRestart(id)
      } else {
        logger.info(`[${id}] Stopped gracefully`)
      }
    })

    child.on('error', (err) => {
      logger.error(`[${id}] Process error: ${err.message}`)
      entry.status = 'error'
    })

    children.set(id, entry)

    // 서버가 listening을 시작하면 ready 상태로 전환
    // startServer에서 process.send를 지원하지 않을 수 있으므로
    // 일정 시간 후 health check로 대체
    setTimeout(() => {
      if (entry.status === 'starting') {
        entry.status = 'running'
        startHealthCheck(id)
      }
    }, 5_000)

    return entry
  }

  const attemptRestart = (id) => {
    const entry = children.get(id)
    if (!entry) return

    const now = Date.now()
    entry.restarts = entry.restarts.filter(t => now - t < RESTART_WINDOW_MS)

    if (entry.restarts.length >= MAX_RESTARTS) {
      logger.error(`[${id}] Exceeded max restarts (${MAX_RESTARTS} in ${RESTART_WINDOW_MS / 1000}s). Marking as failed.`)
      entry.status = 'failed'
      return
    }

    entry.restarts.push(now)
    const delay = Math.min(1000 * Math.pow(2, entry.restarts.length - 1), 10_000)
    logger.info(`[${id}] Restarting in ${delay}ms (attempt ${entry.restarts.length}/${MAX_RESTARTS})...`)

    setTimeout(() => {
      if (entry.status === 'failed') return
      forkInstance(entry.def)
    }, delay)
  }

  const startHealthCheck = (id) => {
    const entry = children.get(id)
    if (!entry) return

    entry.healthTimer = setInterval(async () => {
      const { host = '127.0.0.1', port } = entry.def
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS)
        const res = await fetch(`http://${host}:${port}/api/instance`, { signal: controller.signal })
        clearTimeout(timeout)
        if (res.ok) {
          entry.status = 'running'
        }
      } catch {
        // health check 실패는 프로세스 exit 이벤트에서 처리
      }
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  const clearHealthTimer = (id) => {
    const entry = children.get(id)
    if (entry?.healthTimer) {
      clearInterval(entry.healthTimer)
      entry.healthTimer = null
    }
  }

  const stopInstance = async (id) => {
    const entry = children.get(id)
    if (!entry || entry.status === 'stopped') return

    clearHealthTimer(id)
    entry.status = 'stopping'

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        entry.process.kill('SIGKILL')
        resolve()
      }, 10_000)

      entry.process.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      entry.process.kill('SIGTERM')
    })
  }

  const restartInstance = async (id) => {
    const entry = children.get(id)
    if (!entry) return null
    await stopInstance(id)
    entry.restarts = [] // restart 카운터 리셋
    return forkInstance(entry.def)
  }

  const getStatus = (id) => {
    const entry = children.get(id)
    if (!entry) return null
    return {
      id: entry.def.id,
      port: entry.def.port,
      host: entry.def.host,
      status: entry.status,
      pid: entry.process.pid,
    }
  }

  const listStatus = () =>
    Array.from(children.keys()).map(getStatus).filter(Boolean)

  const shutdownAll = async () => {
    const ids = Array.from(children.keys())
    await Promise.all(ids.map(stopInstance))
  }

  return {
    forkInstance,
    stopInstance,
    restartInstance,
    getStatus,
    listStatus,
    shutdownAll,
  }
}

export { createChildManager }
