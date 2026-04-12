export const SYSTEM_JOBS = Object.freeze({
  TODO_REVIEW: '__todo_review__',
})

export const SESSION_TYPE = Object.freeze({
  USER: 'user',
  SCHEDULED: 'scheduled',
  AGENT: 'agent',
})

const DEFAULT_SESSION_SUFFIX = 'default'
export const defaultSessionId = (username) =>
  username ? `${username}-${DEFAULT_SESSION_SUFFIX}` : `user-${DEFAULT_SESSION_SUFFIX}`
