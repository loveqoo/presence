import Conf from 'conf'

// _접두사 키는 일시적 UI 상태 (_streaming, _debug, _toolResults 등)
const stripTransient = (snap) => {
  const out = {}
  for (const key of Object.keys(snap)) {
    if (!key.startsWith('_')) out[key] = snap[key]
  }
  return out
}

const createPersistence = ({ projectName = 'presence', debounceMs = 500, cwd } = {}) => {
  const confOpts = cwd
    ? { cwd, configName: 'state' }
    : { projectName, configName: 'state' }
  const store = new Conf(confOpts)
  let timer = null

  const save = (state) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        const snap = typeof state.snapshot === 'function' ? state.snapshot() : state
        store.set('agentState', stripTransient(snap))
      } catch (_) {
        // non-fatal: state will be re-saved on next change
      }
      timer = null
    }, debounceMs)
  }

  const saveImmediate = (state) => {
    if (timer) clearTimeout(timer)
    try {
      const snap = typeof state.snapshot === 'function' ? state.snapshot() : state
      store.set('agentState', stripTransient(snap))
    } catch (_) {
      // non-fatal: state will be re-saved on next change
    }
    timer = null
  }

  const restore = () => {
    try { return store.get('agentState', null) }
    catch (_) { return null }
  }

  const clear = () => store.delete('agentState')

  const connectToState = (reactiveState) => {
    // Save on any top-level state change by hooking into common paths
    const hookSave = () => save(reactiveState)
    reactiveState.hooks.on('turnState', hookSave)
    reactiveState.hooks.on('turn', hookSave)
    reactiveState.hooks.on('lastTurn', hookSave)
    return { unhook: () => {
      reactiveState.hooks.off('turnState', hookSave)
      reactiveState.hooks.off('turn', hookSave)
      reactiveState.hooks.off('lastTurn', hookSave)
    }}
  }

  return { save, saveImmediate, restore, clear, connectToState, store }
}

// 순수 함수: id 없는 history 항목에 id 부여
const migrateHistoryIds = (history) => {
  if (!Array.isArray(history)) return []
  let counter = 0
  return history.map(entry => {
    if (entry.id) return entry
    const ts = entry.ts || Date.now()
    const isSummary = entry.input === '[conversation summary]'
    return { ...entry, id: isSummary ? `summary-${ts}-${++counter}` : `h-${ts}-${++counter}` }
  })
}

export { createPersistence, migrateHistoryIds }
