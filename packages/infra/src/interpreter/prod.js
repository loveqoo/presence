import fp from '@presence/core/lib/fun-fp.js'
import { runFreeWithStateT } from '@presence/core/lib/runner.js'
import { Interpreter } from '@presence/core/interpreter/compose.js'
import { stateInterpreterR } from '@presence/core/interpreter/state.js'
import { llmInterpreterR } from '@presence/core/interpreter/llm.js'
import { toolInterpreterR } from '@presence/core/interpreter/tool.js'
import { delegateInterpreterR } from './delegate.js'
import { approvalInterpreterR } from '@presence/core/interpreter/approval.js'
import { controlInterpreterR } from '@presence/core/interpreter/control.js'
import { parallelInterpreterR } from '@presence/core/interpreter/parallel.js'
import { HISTORY, STATE_PATH } from '@presence/core/core/policies.js'

const { StateT, Reader } = fp
const ST = StateT('task')

// --- UI 헬퍼 ---
// ref-count 기반 억제: Parallel 브랜치가 Promise.allSettled로 동시 실행될 때
// 먼저 끝난 브랜치가 restore해도 나머지가 아직 실행 중이면 억제 유지.
// depth === 0일 때만 UI side effect 허용.

const createUiHelpers = (reactiveState) => {
  let depth = 0
  const isEnabled = () => depth === 0 && !!reactiveState

  const streamingUi = {
    set: (data) => { if (isEnabled()) reactiveState.set('_streaming', data) },
    isEnabled,
  }

  const toolResultUi = {
    append: (entry) => {
      if (!isEnabled()) return
      // 현재 턴 UI 용 — 다음 턴 시작 시 reset (기존 동작 유지).
      const prev = reactiveState.get(STATE_PATH.TOOL_RESULTS) || []
      reactiveState.set(STATE_PATH.TOOL_RESULTS, [...prev, entry])
      // 세션 누적 tool 로그 — /clear 까지 유지 (INV-CLR-1 에서 초기화).
      const transcript = reactiveState.get(STATE_PATH.TOOL_TRANSCRIPT) || []
      const next = [...transcript, entry]
      const trimmed = next.length > HISTORY.MAX_TOOL_TRANSCRIPT
        ? next.slice(-HISTORY.MAX_TOOL_TRANSCRIPT)
        : next
      reactiveState.set(STATE_PATH.TOOL_TRANSCRIPT, trimmed)
    },
  }

  const delegateUi = {
    addPending: (entry) => {
      if (isEnabled()) {
        const pending = reactiveState.get('delegates.pending') || []
        reactiveState.set('delegates.pending', [...pending, entry])
      }
    },
  }

  const suppress = () => { depth++ }
  const restore = () => { if (depth > 0) depth-- }

  return { streamingUi, toolResultUi, delegateUi, suppress, restore }
}

// --- Prod Interpreter ---
// 7개 단일 관심사 인터프리터를 합성.

const prodInterpreterR = Reader.asks(({ llm, toolRegistry, userDataStore, reactiveState, agentRegistry, fetchFn, onApprove, getAbortSignal } = {}) => {
  const ui = createUiHelpers(reactiveState)

  let interpret

  const runProgram = async (program, state) => {
    ui.suppress()
    try {
      const [result] = await runFreeWithStateT(interpret, ST)(program)(state)
      return result
    } finally {
      ui.restore()
    }
  }

  const composed = Interpreter.compose(ST,
    stateInterpreterR.run({ ST }),
    llmInterpreterR.run({ ST, llm, streamingUi: ui.streamingUi, getAbortSignal }),
    toolInterpreterR.run({ ST, toolRegistry, userDataStore, toolResultUi: ui.toolResultUi }),
    delegateInterpreterR.run({ ST, agentRegistry, delegateUi: ui.delegateUi, fetchFn }),
    approvalInterpreterR.run({ ST, onApprove }),
    controlInterpreterR.run({ ST }),
    parallelInterpreterR.run({ ST, runProgram }),
  )

  interpret = composed

  return { interpret, ST }
})

export { prodInterpreterR }
