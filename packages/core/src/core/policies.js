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

export const PROMPT = Object.freeze({
  RESULT_MAX_LEN: 500,
  SUMMARIZED_RESULT_MAX_LEN: 200,
  DEFAULT_MAX_CONTEXT_TOKENS: 8000,
  DEFAULT_RESERVED_OUTPUT_TOKENS: 1000,
})

