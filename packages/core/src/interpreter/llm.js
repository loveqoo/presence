import fp from '../lib/fun-fp.js'
import { Interpreter } from './compose.js'

const { Task } = fp

// --- 스트리밍 중 direct_response의 message 필드 추출 ---
// JSON이 부분적으로 도착해도 "message":"..." 내용을 점진적으로 보여준다.

/**
 * Extract the `message` field value from a partially-accumulated JSON stream.
 * Returns `null` if the field or its value has not yet arrived.
 * @param {string} accumulated - Partial JSON string received so far.
 * @returns {string|null}
 */
const extractStreamingMessage = (accumulated) => {
  const marker = '"message":'
  const idx = accumulated.indexOf(marker)
  if (idx === -1) return null

  let start = idx + marker.length
  while (start < accumulated.length && accumulated[start] !== '"') start++
  if (start >= accumulated.length) return null
  start++ // skip opening quote

  let result = ''
  let i = start
  while (i < accumulated.length) {
    if (accumulated[i] === '\\' && i + 1 < accumulated.length) {
      const next = accumulated[i + 1]
      if (next === 'n') result += '\n'
      else if (next === 't') result += '\t'
      else if (next === '"') result += '"'
      else if (next === '\\') result += '\\'
      else if (next === '/') result += '/'
      else if (next === 'u' && i + 5 < accumulated.length) {
        result += String.fromCharCode(parseInt(accumulated.slice(i + 2, i + 6), 16))
        i += 6
        continue
      }
      else result += next
      i += 2
    } else if (accumulated[i] === '"') {
      break
    } else {
      result += accumulated[i]
      i++
    }
  }

  return result || null
}

// --- context 참조 메시지 ---

/**
 * Append a formatted context block as a user message when context entries are present.
 * @param {object[]} messages - Existing chat messages array.
 * @param {Array<string|object>} [context] - Context entries to append.
 * @returns {object[]} New messages array (unchanged if context is empty).
 */
const appendContext = (messages, context) => {
  if (!context || context.length === 0) return messages
  const ctxText = context
    .map((c, i) => `[${i + 1}] ${typeof c === 'string' ? c : JSON.stringify(c)}`)
    .join('\n')
  return [...messages, { role: 'user', content: `참조 컨텍스트:\n${ctxText}` }]
}

// --- LlmInterpreter ---
// AskLLM — LLM 통신 + 스트리밍.

/**
 * Create an interpreter for the `AskLLM` op.
 * Supports streaming via `llm.chatStream` when enabled and no tool calls are present;
 * falls back to non-streaming `llm.chat` otherwise.
 * @param {{ ST: object, llm: object, streamingUi: object, getAbortSignal?: () => AbortSignal }} deps
 * @returns {Interpreter}
 */

const createLlmInterpreter = ({ ST, llm, streamingUi, getAbortSignal }) =>
  new Interpreter(['AskLLM'], (f) =>
    ST.lift(Task.fromPromise(async () => {
      const messages = appendContext(f.messages, f.context)
      const signal = getAbortSignal ? getAbortSignal() : undefined

      // 스트리밍: streamingUi가 활성이고 tool_calls가 아닌 경우
      if (streamingUi.isEnabled() && !f.tools && llm.chatStream) {
        streamingUi.set({ content: '', status: 'connecting' })
        let lastUpdate = 0
        const result = await llm.chatStream({
          messages,
          responseFormat: f.responseFormat,
          signal,
          onDelta: ({ accumulated }) => {
            const now = Date.now()
            if (now - lastUpdate < 50) return
            lastUpdate = now
            const extracted = extractStreamingMessage(accumulated)
            streamingUi.set({
              content: extracted || '',
              status: extracted ? 'streaming' : 'receiving',
              length: accumulated.length,
            })
          },
        })
        return result.content
      }

      // 비스트리밍 폴백 (tool calls 포함)
      const result = await llm.chat({ messages, tools: f.tools, responseFormat: f.responseFormat, signal })
      return result.type === 'tool_calls'
        ? { type: 'tool_calls', toolCalls: result.toolCalls }
        : result.content
    })()).map(value => f.next(value)))

export { createLlmInterpreter, extractStreamingMessage, appendContext }
