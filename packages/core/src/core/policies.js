// --- 턴 상태 ---

export const PHASE = Object.freeze({ IDLE: 'idle', WORKING: 'working' })
export const RESULT = Object.freeze({ SUCCESS: 'success', FAILURE: 'failure' })
export const ERROR_KIND = Object.freeze({
  PLANNER_PARSE:   'planner_parse',
  PLANNER_SHAPE:   'planner_shape',
  INTERPRETER:     'interpreter',
  MAX_ITERATIONS:  'max_iterations',
  ABORTED:         'aborted',
})

// history entry 타입. 기존 entry 는 type 없음 → 'turn' 으로 해석.
export const HISTORY_ENTRY_TYPE = Object.freeze({
  TURN:   'turn',
  SYSTEM: 'system',
})

// SYSTEM entry / transient system message 의 tag 태깅.
// 동일 리터럴이 turn-controller, turn-lifecycle, useAgentMessages 에 등장 → 단일 진원.
export const HISTORY_TAG = Object.freeze({
  CANCEL:  'cancel',
  APPROVE: 'approve',
  REJECT:  'reject',
  WARNING: 'warning',
  ERROR:   'error',
})

export const TurnState = Object.freeze({
  idle:    ()      => ({ tag: PHASE.IDLE }),
  working: (input) => ({ tag: PHASE.WORKING, input }),
})

export const TurnOutcome = Object.freeze({
  success: (input, result)          => ({ tag: RESULT.SUCCESS, input, result }),
  failure: (input, error, response) => ({ tag: RESULT.FAILURE, input, error, response }),
})

export const TurnError = (message, kind, truncated = false) => ({ message, kind, truncated })

// --- 실행 설정 ---

export const DEBUG = Object.freeze({
  MAX_ITERATION_HISTORY: 10,
})

export const HISTORY = Object.freeze({
  MAX_CONVERSATION: 20,
  COMPACTION_THRESHOLD: 15,
  COMPACTION_KEEP: 5,
  MAX_INPUT_CHARS: 500,
  MAX_OUTPUT_CHARS: 1000,
  MAX_TOOL_TRANSCRIPT: 500,
})

export const TURN_SOURCE = Object.freeze({
  USER: 'user',
  EVENT: 'event',
})

export const PERSISTENCE = Object.freeze({
  DEBOUNCE_MS: 500,
  STORE_KEY: 'agentState',
})

export const DELEGATE = Object.freeze({
  POLL_INTERVAL_MS: 10_000,
})

export const SCHEDULER = Object.freeze({
  POLL_INTERVAL_MS: 60_000,
  BACKOFF_BASE_MS: 1_000,
  BACKOFF_EXPONENT: 2,
})

export const JOB = Object.freeze({
  HISTORY_MAX_PER_JOB: 50,
  HISTORY_TTL_DAYS: 90,
})

export const REST_ERROR = Object.freeze({
  AUTH_FAILED: 'AUTH_FAILED',
})

export const WS_RECONNECT = Object.freeze({
  BACKOFF_BASE_MS: 500,
  BACKOFF_MAX_MS: 15_000,
})

// WebSocket close 코드 (wire format). 4001~4003 auth/origin 경로.
export const WS_CLOSE = Object.freeze({
  AUTH_FAILED: 4001,
  PASSWORD_CHANGE_REQUIRED: 4002,
  ORIGIN_NOT_ALLOWED: 4003,
})

export const STATE_PATH = Object.freeze({
  TURN_STATE: 'turnState',
  TURN: 'turn',
  LAST_TURN: 'lastTurn',
  TODOS: 'todos',
  // context
  CONTEXT: 'context',
  CONTEXT_MEMORIES: 'context.memories',
  CONTEXT_CONVERSATION_HISTORY: 'context.conversationHistory',
  // events
  EVENTS: 'events',
  EVENTS_QUEUE: 'events.queue',
  EVENTS_IN_FLIGHT: 'events.inFlight',
  EVENTS_DEAD_LETTER: 'events.deadLetter',
  EVENTS_LAST_PROCESSED: 'events.lastProcessed',
  // delegates
  DELEGATES: 'delegates',
  DELEGATES_PENDING: 'delegates.pending',
  // transient (_ prefix)
  APPROVE: '_approve',
  BUDGET_WARNING: '_budgetWarning',
  COMPACTION_EPOCH: '_compactionEpoch',
  RETRY: '_retry',
  STREAMING: '_streaming',
  RECONNECTING: '_reconnecting',
  TOOL_RESULTS: '_toolResults',
  TOOL_TRANSCRIPT: '_toolTranscript',
  PENDING_INPUT: '_pendingInput',
  // debug
  DEBUG_LAST_TURN: '_debug.lastTurn',
  DEBUG_LAST_PROMPT: '_debug.lastPrompt',
  DEBUG_LAST_RESPONSE: '_debug.lastResponse',
  DEBUG_OP_TRACE: '_debug.opTrace',
  DEBUG_RECALLED_MEMORIES: '_debug.recalledMemories',
  DEBUG_ITERATION_HISTORY: '_debug.iterationHistory',
})

export const EMBEDDING = Object.freeze({
  TIMEOUT_MS: 30_000,
})

export const LLM = Object.freeze({
  TIMEOUT_MS: 120_000,
  LIST_MODELS_TIMEOUT_MS: 10_000,
  FINISH_REASON: Object.freeze({
    STOP: 'stop',
    LENGTH: 'length',
  }),
})

export const TODO = Object.freeze({
  CATEGORY: 'todo',
  STATUS_READY: 'ready',
})

export const CHAT = Object.freeze({
  MAX_VISIBLE: 50,
})

// KG-12: web_fetch 에 SERP URL 이 들어오면 plan validation 에서 차단.
// 검색 엔진 결과 페이지는 HTML 스크래핑이 막히거나 의미 없는 결과를 반환한다.
export const WEB_FETCH = Object.freeze({
  BLOCKED_SERP_PATTERNS: Object.freeze([
    /^https?:\/\/(www\.)?google\.\w+\/search/i,
    /^https?:\/\/(www\.)?bing\.com\/search/i,
    /^https?:\/\/search\.yahoo\.com/i,
    /^https?:\/\/(www\.)?duckduckgo\.com\/\?.*q=/i,
    /^https?:\/\/(www\.)?yandex\.\w+\/search/i,
    /^https?:\/\/(www\.)?baidu\.com\/s/i,
  ]),
})

export const PROMPT = Object.freeze({
  RESULT_MAX_LEN: 500,
  SUMMARIZED_RESULT_MAX_LEN: 200,
  DEFAULT_MAX_CONTEXT_TOKENS: 8000,
  DEFAULT_RESERVED_OUTPUT_TOKENS: 1000,
  BUDGET_WARN_PCT: 90,
})

// EventActor event.type enum — scheduler/a2a 경로에서 공유.
// 정의와 사용이 한 enum 을 참조해야 scheduled_job 콜백 회귀를 막을 수 있다.
// EventActor event.type enum.
// A2A 네이밍 범용화 (v8, 2026-04-24): TODO_REQUEST/TODO_RESPONSE → A2A_REQUEST/A2A_RESPONSE.
// TODO 는 category 필드로 분류 (a2a-internal.md §4.1). TODO_REVIEW 는 별개 도메인 (UserDataStore) 이라 유지.
export const EVENT_TYPE = Object.freeze({
  SCHEDULED_JOB: 'scheduled_job',
  TODO_REVIEW:   'todo_review',
  A2A_REQUEST:   'a2a_request',
  A2A_RESPONSE:  'a2a_response',
})

// A2A Phase 1 정책 상수. S4 enforcement/expire 에서 소비.
export const A2A = Object.freeze({
  QUEUE_MAX_PER_AGENT: 100,
  DEFAULT_TIMEOUT_MS: 300000,
  EXPIRE_TICK_MS: 30000,   // UserContext 의 a2a expire 스캔 주기 (S2)
})

