import fp from '@presence/core/lib/fun-fp.js'
import { PROMPT, STATE_PATH } from '@presence/core/core/policies.js'
import { ActorWrapper } from './actor-wrapper.js'

const { Maybe, Reader } = fp

class BudgetActor extends ActorWrapper {
  static MSG = Object.freeze({ CHECK: 'check' })
  static RESULT = Object.freeze({ SKIP: 'skip', NO_OP: 'no-op', OK: 'ok', WARNED: 'warned' })

  constructor(state) {
    // lastWarnedTurn: 마지막으로 경고를 발행한 턴 번호. -1은 경고 이력 없음.
    // CHECK: 프롬프트 budget 사용률 판별 → 임계치 초과 시 경고 상태 기록, 정상이면 해제.
    super({ lastWarnedTurn: -1 }, (actorState, msg) => {
      const R = BudgetActor.RESULT
      if (msg.type !== BudgetActor.MSG.CHECK) return [R.SKIP, actorState]
      const { debug, turn } = msg
      if (!debug?.assembly) return [R.NO_OP, actorState]
      if (turn === actorState.lastWarnedTurn) return [R.NO_OP, actorState]

      return Maybe.fold(
        () => {
          if (state.get(STATE_PATH.BUDGET_WARNING) != null) state.set(STATE_PATH.BUDGET_WARNING, null)
          return [R.OK, actorState]
        },
        warning => {
          state.set(STATE_PATH.BUDGET_WARNING, warning)
          return [R.WARNED, { lastWarnedTurn: turn }]
        },
        this.detectWarning(debug.assembly),
      )
    })
  }

  check(debug, turn) { return this.send({ type: BudgetActor.MSG.CHECK, debug, turn }) }

  detectWarning({ budget, used, historyDropped }) {
    if (budget === Infinity) return Maybe.Nothing()
    const pct = Math.round(used / budget * 100)
    if (historyDropped > 0) return Maybe.Just({ type: 'history_dropped', dropped: historyDropped, pct })
    if (pct >= PROMPT.BUDGET_WARN_PCT) return Maybe.Just({ type: 'high_usage', pct })
    return Maybe.Nothing()
  }
}

const budgetActorR = Reader.asks(({ state }) => new BudgetActor(state))

export { BudgetActor, budgetActorR }
