import { randomUUID } from 'crypto'
import { DelegateResult } from './agent-registry.js'

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

/**
 * `sendA2ATask(target, endpoint, task, opts?)` — Sends a task to a remote A2A agent via JSON-RPC and returns a DelegateResult.
 * @param {string} target - Logical agent name used in DelegateResult.
 * @param {string} endpoint - Full A2A HTTP endpoint URL.
 * @param {string} task - Free-text task description to send.
 * @param {{ fetchFn?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<DelegateResult>}
 *
 * `getA2ATaskStatus(target, endpoint, taskId, opts?)` — Polls an existing A2A task for its current status.
 * @returns {Promise<DelegateResult>}
 *
 * `extractArtifactText(artifacts)` — Extracts concatenated text parts from A2A artifact array.
 *
 * `buildTaskSendRequest / buildTaskGetRequest` — Pure JSON-RPC request builders.
 *
 * `responseToResult(target, taskId, data)` — Converts a raw A2A JSON-RPC response to a DelegateResult.
 */
export {
  sendA2ATask, getA2ATaskStatus, extractArtifactText,
  buildTaskSendRequest, buildTaskGetRequest, responseToResult,
}
