import Conf from 'conf'

const createPersistence = ({ projectName = 'presence', debounceMs = 500, cwd } = {}) => {
  const confOpts = cwd
    ? { cwd, configName: 'state' }
    : { projectName, configName: 'state' }
  const store = new Conf(confOpts)
  let timer = null

  const save = (state) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const snap = typeof state.snapshot === 'function' ? state.snapshot() : state
      store.set('agentState', snap)
      timer = null
    }, debounceMs)
  }

  const saveImmediate = (state) => {
    if (timer) clearTimeout(timer)
    const snap = typeof state.snapshot === 'function' ? state.snapshot() : state
    store.set('agentState', snap)
    timer = null
  }

  const restore = () => store.get('agentState', null)

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

export { createPersistence }
