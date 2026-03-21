import { randomUUID } from 'crypto'
import { DelegateResult } from './agent-registry.js'
import fp from '../lib/fun-fp.js'

const { Maybe } = fp

// --- A2A artifact에서 텍스트 추출 (순수) ---

const extractArtifactText = (artifacts) => {
  if (!Array.isArray(artifacts)) return null
  return artifacts
    .flatMap(a => (a.parts || []).filter(p => p.kind === 'text').map(p => p.text))
    .join('\n') || null
}

// --- A2A JSON-RPC 요청 빌드 (순수) ---

const buildTaskSendRequest = (taskId, messageText) => ({
  jsonrpc: '2.0',
  id: randomUUID(),
  method: 'message/send',
  params: {
    id: taskId,
    message: {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text: messageText }],
    },
  },
})

const buildTaskGetRequest = (taskId) => ({
  jsonrpc: '2.0',
  id: randomUUID(),
  method: 'tasks/get',
  params: { id: taskId },
})

// --- A2A 응답 → DelegateResult 변환 (순수) ---

const responseToResult = (target, taskId, data) => {
  if (data.error) {
    return DelegateResult.failed(target, data.error.message || JSON.stringify(data.error), 'remote')
  }

  const task = data.result
  if (!task || !task.status) {
    return DelegateResult.failed(target, 'A2A: invalid response (no task status)', 'remote')
  }

  const state = task.status.state
  if (state === 'completed') {
    const output = extractArtifactText(task.artifacts)
    return DelegateResult.completed(target, output, 'remote')
  }
  if (state === 'failed') {
    const reason = task.status.message?.parts?.[0]?.text || 'unknown error'
    return DelegateResult.failed(target, reason, 'remote')
  }

  // submitted, working, input-required 등 → 비동기 진행 중
  return DelegateResult.submitted(target, task.id || taskId, 'remote')
}

// --- A2A task 전송 ---

const a2aFetch = async (_fetch, url, body, timeoutMs = 30_000) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await _fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

const safeJsonParse = async (res) => {
  try { return await res.json() }
  catch (e) { return { error: { code: -32700, message: `Invalid JSON response: ${e.message}` } } }
}

const sendA2ATask = async (target, endpoint, task, { fetchFn, timeoutMs = 30_000 } = {}) => {
  const _fetch = fetchFn || globalThis.fetch
  const taskId = randomUUID()
  const body = buildTaskSendRequest(taskId, task)

  try {
    const res = await a2aFetch(_fetch, endpoint, body, timeoutMs)

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return DelegateResult.failed(target, `A2A HTTP ${res.status}: ${errText}`, 'remote')
    }

    const data = await safeJsonParse(res)
    return responseToResult(target, taskId, data)
  } catch (e) {
    return DelegateResult.failed(target, e.message || String(e), 'remote')
  }
}

// --- A2A task 상태 조회 (폴링용) ---

const getA2ATaskStatus = async (target, endpoint, taskId, { fetchFn, timeoutMs = 10_000 } = {}) => {
  const _fetch = fetchFn || globalThis.fetch
  const body = buildTaskGetRequest(taskId)

  try {
    const res = await a2aFetch(_fetch, endpoint, body, timeoutMs)

    if (!res.ok) {
      return DelegateResult.failed(target, `A2A HTTP ${res.status}`, 'remote')
    }

    const data = await safeJsonParse(res)
    return responseToResult(target, taskId, data)
  } catch (e) {
    return DelegateResult.failed(target, e.message || String(e), 'remote')
  }
}

// --- 비동기 delegate 폴링 hook ---
// turnState=idle일 때 pending delegate를 폴링하고,
// 완료/실패 시 이벤트 큐로 결과를 흘려보냄.

const wireDelegatePolling = ({ state, emit, agentRegistry, fetchFn, logger, pollIntervalMs = 10_000 }) => {
  let timer = null
  let stopped = true
  let polling = false

  const pollPending = async () => {
    if (polling) return
    const ts = state.get('turnState')
    if (!ts || ts.tag !== 'idle') return
    const pending = state.get('delegates.pending') || []
    if (pending.length === 0) return

    polling = true
    try {
      const resolveEndpoint = (entry) =>
        Maybe.fold(
          () => entry.endpoint,
          agent => agent.endpoint || entry.endpoint,
          agentRegistry ? agentRegistry.get(entry.target) : Maybe.Nothing(),
        )

      const pollEntry = async (entry) => {
        const endpoint = resolveEndpoint(entry)
        if (!endpoint) return { entry, done: false }
        const result = await getA2ATaskStatus(entry.target, endpoint, entry.taskId, { fetchFn })
        return { entry, result, done: result.status === 'completed' || result.status === 'failed' }
      }

      const settled = await Promise.all(pending.map(pollEntry))

      settled
        .filter(s => s.done)
        .forEach(s => {
          emit({ type: 'delegate_result', target: s.entry.target, taskId: s.entry.taskId, result: s.result })
          if (logger) logger.info(`Delegate ${s.result.status}: ${s.entry.target}/${s.entry.taskId}`)
        })

      state.set('delegates.pending', settled.filter(s => !s.done).map(s => s.entry))
    } finally {
      polling = false
    }
  }

  // 주기적 폴링 (setTimeout self-scheduling)
  const tick = async () => {
    if (stopped) return
    await pollPending()
    if (!stopped) timer = setTimeout(tick, pollIntervalMs)
  }

  // turnState idle 시에도 즉시 한 번 시도
  state.hooks.on('turnState', (phase) => {
    if (phase.tag === 'idle') pollPending()
  })

  const start = () => {
    if (!stopped) return
    stopped = false
    timer = setTimeout(tick, pollIntervalMs)
  }

  const stop = () => {
    stopped = true
    if (timer) { clearTimeout(timer); timer = null }
  }

  return { start, stop, pollPending }
}

export {
  sendA2ATask, getA2ATaskStatus, extractArtifactText,
  buildTaskSendRequest, buildTaskGetRequest, responseToResult,
  wireDelegatePolling,
}
