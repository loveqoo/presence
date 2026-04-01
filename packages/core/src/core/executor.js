import { runFreeWithStateT } from '../lib/runner.js'
import { forkTask, fireAndForget } from '../lib/task.js'
import { RESULT, ERROR_KIND } from './policies.js'
import { getByPath } from '../lib/path.js'
import { Phase, TurnResult, ErrorInfo } from './turn.js'
import { applyFinalState } from './stateCommit.js'

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
    this.state.set('turnState', Phase.working(input))
    this.state.set('turn', (this.state.get('turn') || 0) + 1)
    this.state.set('_debug.iterationHistory', [])
  }

  async recallMemories(input) {
    const { state, actors: { memoryActor, logger } } = this
    if (!memoryActor || !state) return
    try {
      const memories = await forkTask(memoryActor.send({ type: 'recall', input }))
      state.set('context.memories', memories.map(n => n.label))
      state.set('_debug.recalledMemories', memories.map(n => ({
        label: n.label, type: n.type, tier: n.tier,
        createdAt: n.createdAt, embeddedAt: n.embeddedAt,
      })))
    } catch (e) {
      state.set('context.memories', [])
      state.set('_debug.recalledMemories', [])
      ;(logger || console).warn('Memory recall failed', { error: e.message })
    }
  }

  afterTurn(finalState, initialEpoch) {
    const { actors: { memoryActor, compactionActor, persistenceActor } } = this
    if (memoryActor) this.postTurnMemory(memoryActor, finalState)
    if (compactionActor) {
      const history = getByPath(finalState, 'context.conversationHistory') || []
      fireAndForget(compactionActor.send({ type: 'check', history, epoch: initialEpoch }))
    }
    applyFinalState(this.state, finalState, { initialEpoch })
    this.persist()
  }

  postTurnMemory(memoryActor, finalState) {
    const lastTurn = getByPath(finalState, 'lastTurn')
    if (lastTurn?.tag === RESULT.SUCCESS) {
      fireAndForget(memoryActor.send({ type: 'save', node: {
        label: lastTurn.input || 'unknown',
        type: 'conversation', tier: 'episodic',
        data: { input: lastTurn.input, output: lastTurn.result },
      }}))
    }
  }

  persist() {
    const { actors: { persistenceActor } } = this
    if (persistenceActor && this.state) {
      fireAndForget(persistenceActor.send({ type: 'save', snapshot: this.state.snapshot() }))
    }
  }

  recover(input, err) {
    if (this.state) {
      const recovery = {
        _streaming: null,
        lastTurn: TurnResult.failure(input, ErrorInfo(err.message || String(err), ERROR_KIND.INTERPRETER), null),
        turnState: Phase.idle(),
      }
      for (const [key, value] of Object.entries(recovery)) this.state.set(key, value)
    }
    this.persist()
  }
}

export { Executor }
