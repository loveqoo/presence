// =============================================================================
// @presence/server 도메인 상수
// =============================================================================

import { STATE_PATH, WS_CLOSE } from '@presence/core/core/policies.js'

export { WS_CLOSE }

// 유저 컨텍스트 비활성 타임아웃 (30분)
export const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000

// State → WS 브로드캐스트 감시 경로
export const WATCHED_PATHS = Object.freeze([
  STATE_PATH.TURN_STATE, STATE_PATH.LAST_TURN, STATE_PATH.TURN,
  STATE_PATH.CONTEXT_MEMORIES, STATE_PATH.CONTEXT_CONVERSATION_HISTORY,
  STATE_PATH.STREAMING, '_retry', STATE_PATH.APPROVE,
  STATE_PATH.DEBUG_LAST_TURN, STATE_PATH.DEBUG_LAST_PROMPT, STATE_PATH.DEBUG_LAST_RESPONSE,
  STATE_PATH.DEBUG_OP_TRACE, STATE_PATH.DEBUG_RECALLED_MEMORIES, STATE_PATH.DEBUG_ITERATION_HISTORY,
  STATE_PATH.BUDGET_WARNING, STATE_PATH.TOOL_RESULTS,
  STATE_PATH.TODOS, STATE_PATH.EVENTS, 'events.*', STATE_PATH.DELEGATES, 'delegates.*',
])
