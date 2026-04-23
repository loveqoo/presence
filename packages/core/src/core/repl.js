import fp from '../lib/fun-fp.js'
import { COMMANDS, DISPATCH } from './repl-commands.js'

const { identity } = fp

class Repl {
  constructor(opts) {
    this.agent = opts.agent
    this.onOutput = opts.onOutput
    this.onError = opts.onError
    this.state = opts.state
    this.toolRegistry = opts.toolRegistry
    this.agentRegistry = opts.agentRegistry
    this.memory = opts.memory
    this.mcp = opts.mcp
    this.agentId = opts.agentId
    this.t = opts.t || identity
    this._running = true
    this._turnCount = 0
  }

  get running() { return this._running }
  get turnCount() { return this._turnCount }
  stop() { this._running = false }

  emit(text) { if (this.onOutput) this.onOutput(text) }

  async handleInput(input) {
    const key = input.split(/\s/)[0]
    const handler = DISPATCH[key]
    if (key === '/quit' || key === '/exit') { this.stop(); return null }
    if (handler) {
      await handler(this, input)
      return null
    }

    this._turnCount++
    try {
      const result = await this.agent.run(input)
      this.emit(result)
      return result
    } catch (err) {
      if (this.onError) this.onError(err)
      return null
    }
  }
}

export { Repl, COMMANDS }
