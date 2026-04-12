// --- 턴 상태 ---

export const PHASE = Object.freeze({ IDLE: 'idle', WORKING: 'working' })
export const RESULT = Object.freeze({ SUCCESS: 'success', FAILURE: 'failure' })
export const ERROR_KIND = Object.freeze({
  PLANNER_PARSE:   'planner_parse',
  PLANNER_SHAPE:   'planner_shape',
  INTERPRETER:     'interpreter',
  MAX_ITERATIONS:  'max_iterations',
})

export const TurnState = Object.freeze({
  idle:    ()      => ({ tag: PHASE.IDLE }),
  working: (input) => ({ tag: PHASE.WORKING, input }),
})

export const TurnOutcome = Object.freeze({
  success: (input, result)          => ({ tag: RESULT.SUCCESS, input, result }),
  failure: (input, error, response) => ({ tag: RESULT.FAILURE, input, error, response }),
})

export const TurnError = (message, kind) => ({ message, kind })

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

// WebSocket close 코드 (wire format)
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
  STREAMING: '_streaming',
  RECONNECTING: '_reconnecting',
  TOOL_RESULTS: '_toolResults',
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
})

export const TODO = Object.freeze({
  CATEGORY: 'todo',
  STATUS_READY: 'ready',
})

export const PROMPT = Object.freeze({
  RESULT_MAX_LEN: 500,
  SUMMARIZED_RESULT_MAX_LEN: 200,
  DEFAULT_MAX_CONTEXT_TOKENS: 8000,
  DEFAULT_RESERVED_OUTPUT_TOKENS: 1000,
  BUDGET_WARN_PCT: 90,
})

