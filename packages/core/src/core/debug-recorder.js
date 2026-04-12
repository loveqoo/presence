/**
 * Debug Recorder — iteration history + 디버그 정보 기록
 *
 * planner.js에서 분리. Planner가 소유하여 사용.
 */
import { updateState, getState } from './op.js'
import { DEBUG } from './policies.js'
import fp from '../lib/fun-fp.js'

const { Either } = fp

class DebugRecorder {
  record(turn, prompt, rawResponse, parsed, { iteration, retryAttempt = 0 } = {}) {
    const debugInfo = {
      input: turn.input,
      iteration,
      retryAttempt,
      memories: turn.memories.slice(0, 20),
      prompt: {
        systemLength: prompt.messages[0]?.content?.length || 0,
        messageCount: prompt.messages.length,
        hasRollingContext: turn.previousPlan != null,
      },
      llmResponseLength: rawResponse.length,
      parsedType: Either.fold(() => null, p => p.type, parsed),
      stepCount: Either.fold(() => null, p => p.steps?.length || 0, parsed),
      error: Either.fold(e => e.message, () => null, parsed),
      assembly: prompt._assembly,
      timestamp: Date.now(),
    }
    const iterEntry = {
      ...debugInfo,
      promptMessages: prompt.messages.length,
      promptChars: prompt.messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0),
      response: rawResponse,
    }
    return updateState('_debug.lastTurn', debugInfo)
      .chain(() => updateState('_debug.lastPrompt', prompt.messages))
      .chain(() => updateState('_debug.lastResponse', rawResponse))
      .chain(() => getState('_debug.iterationHistory').chain(prev => {
        const history = [...(prev || []), iterEntry]
        const capped = history.length > DEBUG.MAX_ITERATION_HISTORY
          ? history.slice(-DEBUG.MAX_ITERATION_HISTORY)
          : history
        return updateState('_debug.iterationHistory', capped)
      }))
  }
}

export { DebugRecorder }
