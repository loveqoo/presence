import { tracedInterpreterR } from '@presence/core/interpreter/traced.js'
import { prodInterpreterR } from '../../../interpreter/prod.js'
import { STATE_PATH } from '@presence/core/core/policies.js'
import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

// =============================================================================
// sessionInterpreterR: prod interpreter + trace 래핑.
// Reader.local로 env 변환, chain으로 단계 합성.
// Reader({ llm, toolRegistry, state, agentRegistry, turnController, logger })
//   → { interpret, ST, resetTrace }
// =============================================================================

const sessionInterpreterR =
  Reader.local(
    env => ({
      llm: env.llm, toolRegistry: env.toolRegistry, reactiveState: env.state,
      agentRegistry: env.agentRegistry,
      onApprove: (desc) => env.turnController.onApprove(desc),
      getAbortSignal: () => env.turnController.getAbortSignal(),
    }),
    prodInterpreterR,
  ).chain(prod => Reader.asks(({ state, logger }) => {
    const traced = tracedInterpreterR.run({
      interpret: prod.interpret,
      ST: prod.ST,
      logger,
      onOp: (event) => {
        if (event !== 'start') state.set(STATE_PATH.DEBUG_OP_TRACE, traced.getTrace())
      },
    })
    return { interpret: traced.interpret, ST: traced.ST, resetTrace: traced.resetTrace }
  }))

export { sessionInterpreterR }
