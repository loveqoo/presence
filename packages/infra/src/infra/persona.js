import Conf from 'conf'
import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

const STORE_KEY = 'persona'

const DEFAULT_PERSONA = Object.freeze({
  name: 'Presence',
  systemPrompt: null, // null → use default ROLE_DEFINITION from prompt.js
  rules: [],
  tools: [], // empty → all tools allowed
})

class Persona {
  #store

  constructor(store) {
    this.#store = store
  }

  get store() { return this.#store }

  get() {
    const saved = this.#store.get(STORE_KEY, {})
    return { ...DEFAULT_PERSONA, ...saved }
  }

  set(updates) {
    const current = this.get()
    this.#store.set(STORE_KEY, { ...current, ...updates })
  }

  reset() {
    this.#store.delete(STORE_KEY)
  }

  filterTools(allTools) {
    const persona = this.get()
    if (!persona.tools || persona.tools.length === 0) return allTools
    const allowed = new Set(persona.tools)
    return allTools.filter(tool => allowed.has(tool.name))
  }
}

const createPersonaR = Reader.asks(({ projectName = 'presence', cwd } = {}) => {
  const confOpts = cwd
    ? { cwd, configName: STORE_KEY }
    : { projectName, configName: STORE_KEY }
  return new Persona(new Conf(confOpts))
})

// 레거시 브릿지
const createPersona = (opts = {}) => createPersonaR.run(opts)

export { Persona, createPersonaR, createPersona }
