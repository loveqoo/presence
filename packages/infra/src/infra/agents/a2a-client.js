import { randomUUID } from 'crypto'
import { Delegation, DelegationMode } from './delegation.js'
import { JsonRpc, Method, Message, A2ATask } from './a2a-protocol.js'

// =============================================================================
// A2A client: a2a-protocol.js 스키마를 HTTP transport에 조립.
// 알고리즘:
//   1. JSON-RPC request 빌드 (method + params)
//   2. endpoint에 POST (timeout + abort)
//   3. response 파싱 → A2ATask.fromResponse로 Delegation 매핑
// HTTP/네트워크 오류는 Delegation.failed로 격리.
//
// 확장 포인트 (override):
//   - call(target, endpoint, request, taskId, timeoutMs):
//       요청/응답 파이프라인. caching, retry, logging 삽입
//   - post(endpoint, body, timeoutMs):
//       transport 레이어. HTTP → WebSocket/gRPC 교체
// =============================================================================

const SEND_TIMEOUT_MS = 30_000
const POLL_TIMEOUT_MS = 10_000

class A2AClient {
  constructor(opts = {}) {
    this.fetchFn = opts.fetchFn || globalThis.fetch
  }

  // 새 task 전송 — message/send 메서드. KG-17: callerToken 전달 (A2A JWT).
  async sendTask(target, endpoint, taskText, { callerToken } = {}) {
    const taskId = randomUUID()
    const request = JsonRpc.request(Method.SEND, { id: taskId, message: Message.userText(taskText) })
    return this.call(target, endpoint, request, taskId, SEND_TIMEOUT_MS, callerToken)
  }

  // 기존 task 상태 조회 — tasks/get 메서드 (폴링용).
  async getTaskStatus(target, endpoint, taskId, { callerToken } = {}) {
    const request = JsonRpc.request(Method.GET, { id: taskId })
    return this.call(target, endpoint, request, taskId, POLL_TIMEOUT_MS, callerToken)
  }

  // 공통 호출 파이프라인 (override 가능).
  async call(target, endpoint, request, taskId, timeoutMs, callerToken) {
    try {
      const res = await this.post(endpoint, request, timeoutMs, callerToken)
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        return Delegation.failed(target, `A2A HTTP ${res.status}: ${errText}`, DelegationMode.REMOTE)
      }
      const data = await JsonRpc.parseResponse(res)
      return A2ATask.fromResponse(target, taskId, data)
    } catch (e) {
      return Delegation.failed(target, e.message || String(e), DelegationMode.REMOTE)
    }
  }

  // HTTP transport (override 가능). KG-17: callerToken 있으면 Authorization 첨부.
  async post(endpoint, body, timeoutMs, callerToken) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const headers = { 'Content-Type': 'application/json' }
    if (callerToken) headers.Authorization = `Bearer ${callerToken}`
    try {
      return await this.fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

export { A2AClient }
