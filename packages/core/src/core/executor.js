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
    // 입력 즉시 표시용 pending input (FE 가 WS 로 받아 render).
    // ts 는 "이 pending 이 언제 시작되었는가" 를 기록. 이후 turn entry 의 ts 와 비교하여
    // "같은 input 의 과거 턴" vs "이번 pending 이 persisted" 를 구분 가능 (TUI dedup).
    this.state.set(STATE_PATH.PENDING_INPUT, { input, ts: Date.now() })
  }

  async recallMemories(input) {
    const { state, actors: { memoryActor, logger } } = this
    if (!memoryActor || !state) return
    try {
      const memories = await forkTask(memoryActor.recall(input))
      state.set(STATE_PATH.CONTEXT_MEMORIES, memories.map(n => n.label))
      state.set(STATE_PATH.DEBUG_RECALLED_MEMORIES, memories.map(n => ({
        label: n.label, createdAt: n.createdAt,
      })))
    } catch (e) {
      state.set(STATE_PATH.CONTEXT_MEMORIES, [])
      state.set(STATE_PATH.DEBUG_RECALLED_MEMORIES, [])
      ;(logger || console).warn('Memory recall failed', { error: e.message })
    }
  }

  afterTurn(finalState, initialEpoch) {
    const { actors: { memoryActor, compactionActor } } = this
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

  // 실패/중단 경로. abort 확정 여부로 TurnLifecycle 의 imperative API 를 선택.
  // INV-ABT-1: abort 판별 = err.name === 'AbortError' || turnController.isAborted() (OR).
  recover(input, err) {
    if (!this.state) return
    const { turnLifecycle, isAborted } = this.actors
    const aborted = err?.name === 'AbortError' || (isAborted && isAborted())
    const turn = { input }

    if (turnLifecycle) {
      if (aborted) turnLifecycle.recordAbortSync(this.state, turn)
      else turnLifecycle.recordFailureSync(this.state, turn, err)
    }

    const kind = aborted ? ERROR_KIND.ABORTED : ERROR_KIND.INTERPRETER
    const error = TurnError(err?.message || String(err), kind)
    this.state.set(STATE_PATH.STREAMING, null)
    this.state.set(STATE_PATH.PENDING_INPUT, null)
    this.state.set(STATE_PATH.LAST_TURN, TurnOutcome.failure(input, error, null))
    this.state.set(STATE_PATH.TURN_STATE, TurnState.idle())
    this.persist()
  }
}

export { Executor }
