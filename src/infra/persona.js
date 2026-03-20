import Conf from 'conf'

const DEFAULT_PERSONA = {
  name: 'Presence',
  systemPrompt: null, // null → use default ROLE_DEFINITION from prompt.js
  rules: [],
  tools: [], // empty → all tools allowed
}

const createPersona = ({ projectName = 'presence', cwd } = {}) => {
  const confOpts = cwd
    ? { cwd, configName: 'persona' }
    : { projectName, configName: 'persona' }
  const store = new Conf(confOpts)

  const get = () => {
    const saved = store.get('persona', {})
    return { ...DEFAULT_PERSONA, ...saved }
  }

  const set = (updates) => {
    const current = get()
    store.set('persona', { ...current, ...updates })
  }

  const reset = () => {
    store.delete('persona')
  }

  const filterTools = (allTools) => {
    const persona = get()
    if (!persona.tools || persona.tools.length === 0) return allTools
    const allowed = new Set(persona.tools)
    return allTools.filter(t => allowed.has(t.name))
  }

  return { get, set, reset, filterTools, store }
}

export { createPersona, DEFAULT_PERSONA }
