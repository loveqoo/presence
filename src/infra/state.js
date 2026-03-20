// --- Deep clone utility ---
const deepClone = obj => JSON.parse(JSON.stringify(obj))

// --- Path utilities ---
const parsePath = path => path.split('.')

const getByPath = (obj, path) => {
  const keys = parsePath(path)
  let current = obj
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

const setByPath = (obj, path, value) => {
  const keys = parsePath(path)
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = {}
    }
    current = current[key]
  }
  current[keys[keys.length - 1]] = value
}

// --- createState ---
const createState = (initial = {}) => {
  const data = deepClone(initial)

  const get = path => {
    if (path == null) return deepClone(data)
    return getByPath(data, path)
  }

  const set = (path, value) => {
    setByPath(data, path, value)
  }

  const snapshot = () => deepClone(data)

  return { get, set, snapshot }
}

// --- createHooks ---
const createHooks = () => {
  const hooks = new Map()
  let fireDepth = 0
  const MAX_DEPTH = 10

  const on = (path, cb) => {
    if (!hooks.has(path)) hooks.set(path, [])
    hooks.get(path).push(cb)
  }

  const off = (path, cb) => {
    if (!hooks.has(path)) return
    const cbs = hooks.get(path)
    const idx = cbs.indexOf(cb)
    if (idx !== -1) cbs.splice(idx, 1)
  }

  const fire = async (path, value, state) => {
    if (fireDepth >= MAX_DEPTH) return
    fireDepth++
    try {
      // Exact match
      const cbs = hooks.get(path) || []
      for (const cb of [...cbs]) {
        try { await cb(value, state) }
        catch (_) { /* error isolation */ }
      }
      // Wildcard match: 'events.*' matches 'events.github'
      for (const [pattern, wcbs] of hooks) {
        if (!pattern.includes('*')) continue
        const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$')
        if (regex.test(path)) {
          for (const cb of [...wcbs]) {
            try { await cb(value, state) }
            catch (_) { /* error isolation */ }
          }
        }
      }
    } finally {
      fireDepth--
    }
  }

  return { on, off, fire }
}

// --- createReactiveState ---
const createReactiveState = (initial = {}) => {
  const state = createState(initial)
  const hooks = createHooks()

  const set = (path, value) => {
    state.set(path, value)
    hooks.fire(path, value, reactiveState)
  }

  const reactiveState = {
    get: state.get,
    set,
    snapshot: state.snapshot,
    hooks,
  }

  return reactiveState
}

export { createState, createHooks, createReactiveState }
