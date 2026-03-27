// --- Debug policy ---
export const DEBUG = Object.freeze({
  MAX_ITERATION_HISTORY: 10,
})

// --- History policy ---
export const HISTORY = Object.freeze({
  MAX_CONVERSATION: 20,
  COMPACTION_THRESHOLD: 15,
  COMPACTION_KEEP: 5,
  MAX_INPUT_CHARS: 500,
  MAX_OUTPUT_CHARS: 1000,
})

// --- Memory policy ---
export const MEMORY = Object.freeze({
  MAX_EPISODIC: 100,
  PROMOTION_THRESHOLD: 3,
})

// --- Prompt policy ---
export const PROMPT = Object.freeze({
  RESULT_MAX_LEN: 500,
  SUMMARIZED_RESULT_MAX_LEN: 200,
  DEFAULT_MAX_CONTEXT_TOKENS: 8000,
  DEFAULT_RESERVED_OUTPUT_TOKENS: 1000,
})

// --- System job names ---
export const SYSTEM_JOBS = Object.freeze({
  TODO_REVIEW: '__todo_review__',
})

// --- Session types ---
export const SESSION_TYPE = Object.freeze({
  USER: 'user',
  SCHEDULED: 'scheduled',
  AGENT: 'agent',  // 서브 에이전트 세션: persistence 없음, 장기 유지
})
