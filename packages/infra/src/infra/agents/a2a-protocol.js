import { randomUUID } from 'crypto'
import { Delegation, DelegationMode } from './delegation.js'

// =============================================================================
// A2A protocol: JSON-RPC 2.0 기반 Agent-to-Agent 통신 스키마.
// Transport-agnostic — HTTP/WebSocket 등 transport는 별도 모듈.
//
// 지원 범위 (delegation에 필요한 최소 surface):
//   - message/send  (새 task 전송)
//   - tasks/get     (task 상태 조회)
// 미구현:
//   - tasks/cancel, tasks/stream, agent/card discovery 등
// =============================================================================

// --- JSON-RPC 2.0 envelope ---

// JSON-RPC 에러 코드 — 표준 (-326xx) + presence 특화 (-320xx).
// 표준: https://www.jsonrpc.org/specification#error_object
const JsonRpcErrorCode = Object.freeze({
  // 표준
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  // Presence A2A 전용 (server-defined 범위 -32000 ~ -32099)
  AUTH_MISSING: -32000,
  ACCESS_DENIED: -32001,
})

const JsonRpc = {
  request: (method, params) => ({
    jsonrpc: '2.0',
    id: randomUUID(),
    method,
    params,
  }),

  // 응답 해석: HTTP response body 문자열을 JSON-RPC로 파싱.
  // 파싱 실패 시 parse error로 가장한 response 반환.
  parseResponse: async (res) => {
    try { return await res.json() }
    catch (e) { return { error: { code: JsonRpcErrorCode.PARSE_ERROR, message: `Invalid JSON response: ${e.message}` } } }
  },
}

// --- A2A methods (지원 대상 enum) ---

const Method = Object.freeze({
  SEND: 'message/send',
  GET: 'tasks/get',
  // 미구현 (명세 확장 시 추가):
  // CANCEL: 'tasks/cancel',
  // STREAM: 'tasks/stream',
  // AGENT_CARD: 'agent/card',
})

// --- A2A task state machine ---

const TaskState = Object.freeze({
  SUBMITTED: 'submitted',
  WORKING: 'working',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INPUT_REQUIRED: 'input-required',
})

// --- 도메인 타입: Message / Part / Artifact ---

const Part = {
  text: (text) => ({ kind: 'text', text }),
}

const Message = {
  userText: (text) => ({
    kind: 'message',
    messageId: randomUUID(),
    role: 'user',
    parts: [Part.text(text)],
  }),
}

const Artifact = {
  // 모든 text part를 연결. text가 하나도 없으면 null.
  extractText: (artifacts) => {
    if (!Array.isArray(artifacts)) return null
    return artifacts
      .flatMap(a => (a.parts || []).filter(p => p.kind === 'text').map(p => p.text))
      .join('\n') || null
  },
}

// --- Task 상태 → Delegation 매핑 (state machine) ---

const A2ATask = {
  // JSON-RPC response(data)를 Delegation로 변환.
  // error 필드가 있으면 failed. result가 없거나 status 누락이면 invalid.
  // state가 COMPLETED면 artifact에서 텍스트 추출, FAILED면 reason 추출,
  // 그 외(SUBMITTED/WORKING/INPUT_REQUIRED)는 비동기 진행 중으로 submitted 반환.
  fromResponse: (target, taskId, data) => {
    if (data.error) {
      return Delegation.failed(target, data.error.message || JSON.stringify(data.error), DelegationMode.REMOTE)
    }
    const task = data.result
    if (!task || !task.status) {
      return Delegation.failed(target, 'A2A: invalid response (no task status)', DelegationMode.REMOTE)
    }
    switch (task.status.state) {
      case TaskState.COMPLETED:
        return Delegation.completed(target, Artifact.extractText(task.artifacts), DelegationMode.REMOTE)
      case TaskState.FAILED: {
        const reason = task.status.message?.parts?.[0]?.text || 'unknown error'
        return Delegation.failed(target, reason, DelegationMode.REMOTE)
      }
      default:
        // SUBMITTED, WORKING, INPUT_REQUIRED → 비동기 진행 중
        return Delegation.submitted(target, task.id || taskId, DelegationMode.REMOTE)
    }
  },
}

export { JsonRpc, JsonRpcErrorCode, Method, TaskState, Message, Part, Artifact, A2ATask }
