import { runFreeWithStateT } from '../lib/runner.js'
import { forkTask, fireAndForget } from '../lib/task.js'
import { RESULT, ERROR_KIND, TurnState, TurnOutcome, TurnError, STATE_PATH } from './policies.js'
import { getByPath } from '../lib/path.js'
import { applyFinalState } from './state-commit.js'

class Executor {
  constructor({ interpret, ST, state, actors = {} }) {
    this.interpret = interpret
    this.ST = ST
    this.state = state
    this.actors = actors
  }

  async run(program, input) {
    this.beginLifecycle(input)
    await this.recallMemories(input)

    const initialSnapshot = this.state ? this.state.snapshot() : {}
    const initialEpoch = initialSnapshot._compactionEpoch || 0

    try {
      const [result, finalState] = await runFreeWithStateT(this.interpret, this.ST)(program)(initialSnapshot)
      this.afterTurn(finalState, initialEpoch)
      return result
    } catch (err) {
      this.recover(input, err)
      throw err
    }
  }

  beginLifecycle(input) {
    if (!this.state) return
    this.state.set(STATE_PATH.TURN_STATE, TurnState.working(input))
    this.state.set(STATE_PATH.TURN, (this.state.get(STATE_PATH.TURN) || 0) + 1)
    this.state.set(STATE_PATH.DEBUG_ITERATION_HISTORY, [])
  }

  async recallMemories(input) {
    const { state, actors: { memoryActor, logger } } = this
    if (!memoryActor || !state) return
    try {
      const memories = await forkTask(memoryActor.recall(input))
      state.set(STATE_PATH.CONTEXT_MEMORIES, memories.map(n => n.label))
      state.set(STATE_PATH.DEBUG_RECALLED_MEMORIES, memories.map(n => ({
        label: n.label, type: n.type, tier: n.tier,
        createdAt: n.createdAt, embeddedAt: n.embeddedAt,
      })))
    } catch (e) {
      state.set(STATE_PATH.CONTEXT_MEMORIES, [])
      state.set(STATE_PATH.DEBUG_RECALLED_MEMORIES, [])
      ;(logger || console).warn('Memory recall failed', { error: e.message })
    }
  }

  afterTurn(finalState, initialEpoch) {
    const { actors: { memoryActor, compactionActor, persistenceActor } } = this
    if (memoryActor) this.postTurnMemory(memoryActor, finalState)
    if (compactionActor) {
      const history = getByPath(finalState, 'context.conversationHistory') || []
      fireAndForget(compactionActor.check(history, initialEpoch))
    }
    applyFinalState(this.state, finalState, { initialEpoch })
    this.persist()
  }

  postTurnMemory(memoryActor, finalState) {
    const lastTurn = getByPath(finalState, 'lastTurn')
    if (lastTurn?.tag === RESULT.SUCCESS) {
      fireAndForget(memoryActor.save({
        label: lastTurn.input || 'unknown',
        type: 'conversation', tier: 'episodic',
        data: { input: lastTurn.input, output: lastTurn.result },
      }))
    }
  }

  persist() {
    const { actors: { persistenceActor } } = this
    if (persistenceActor && this.state) {
      fireAndForget(persistenceActor.save(this.state.snapshot()))
    }
  }

  recover(input, err) {
    if (this.state) {
      const recovery = {
        [STATE_PATH.STREAMING]: null,
        [STATE_PATH.LAST_TURN]: TurnOutcome.failure(input, TurnError(err.message || String(err), ERROR_KIND.INTERPRETER), null),
        [STATE_PATH.TURN_STATE]: TurnState.idle(),
      }
      for (const [key, value] of Object.entries(recovery)) this.state.set(key, value)
    }
    this.persist()
  }
}

export { Executor }
