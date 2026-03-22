const wireBudgetWarning = ({ state }) => {
  let lastWarnedTurn = -1

  state.hooks.on('_debug.lastTurn', (debug, s) => {
    if (!debug?.assembly) return
    const turn = s.get('turn') || 0
    if (turn === lastWarnedTurn) return

    const { budget, used, historyDropped } = debug.assembly
    if (budget === Infinity) return
    const pct = Math.round(used / budget * 100)

    if (historyDropped > 0) {
      lastWarnedTurn = turn
      s.set('_budgetWarning', {
        type: 'history_dropped',
        dropped: historyDropped,
        pct,
      })
    } else if (pct >= 90) {
      lastWarnedTurn = turn
      s.set('_budgetWarning', { type: 'high_usage', pct })
    }
  })
}

export { wireBudgetWarning }
