import { Planner } from './planner.js'
import { Executor } from './executor.js'

class Agent {
  constructor({
    resolveTools, resolveAgents, persona, responseFormatMode,
    maxRetries, maxIterations, budget, t,
    interpret, ST, state, actors,
    planner, executor,
  }) {
    this.planner = planner || new Planner({
      resolveTools, resolveAgents, persona, responseFormatMode,
      maxRetries, maxIterations, budget, t,
    })
    this.executor = executor || new Executor({ interpret, ST, state, actors })
  }

  withTools(tools) {
    return new Agent({
      planner: this.planner.withTools(tools),
      executor: this.executor,
    })
  }

  run(input, opts) {
    return this.executor.run(this.planner.program(input, opts), input)
  }
}

export { Agent }
