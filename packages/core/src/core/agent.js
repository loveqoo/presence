import { Planner } from './planner.js'
import { Executor } from './executor.js'

class Agent {
  constructor(opts = {}) {
    const {
      resolveTools, resolveAgents, persona, responseFormatMode,
      maxRetries, maxIterations, budget, t, lifecycle,
      interpret, ST, state, actors,
      planner, executor,
    } = opts
    // Session 이 주입한 lifecycle 을 Planner 로 forward. 누락 시 actors.turnLifecycle 에서.
    this.planner = planner || new Planner({
      resolveTools, resolveAgents, persona, responseFormatMode,
      maxRetries, maxIterations, budget, t,
      lifecycle: lifecycle || actors?.turnLifecycle,
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
