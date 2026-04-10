import fp from '../lib/fun-fp.js'
import { Interpreter } from './compose.js'

const { Task, Reader } = fp

// JSON이 부분적으로 도착해도 "message":"..." 내용을 점진적으로 보여준다.
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

const llmInterpreterR = Reader.asks(({ ST, llm, streamingUi, getAbortSignal }) =>
  new Interpreter(['AskLLM'], (f) =>
    ST.lift(Task.fromPromise(async () => {
      const ctx = f.context
      const messages = (!ctx || ctx.length === 0) ? f.messages : [
        ...f.messages,
        { role: 'user', content: `참조 컨텍스트:\n${ctx.map((c, i) => `[${i + 1}] ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n')}` },
      ]
      const signal = getAbortSignal ? getAbortSignal() : undefined

      // 스트리밍: streamingUi가 활성이고 tool_calls가 아닌 경우
      if (streamingUi.isEnabled() && !f.tools && llm.chatStream) {
        streamingUi.set({ content: '', status: 'connecting' })
        let lastUpdate = 0
        const result = await llm.chatStream({
          messages,
          responseFormat: f.responseFormat,
          signal,
          onDelta: ({ accumulated, reasoning }) => {
            const now = Date.now()
            if (now - lastUpdate < 50) return
            lastUpdate = now
            const extracted = extractStreamingMessage(accumulated)
            streamingUi.set({
              content: extracted || '',
              status: reasoning ? 'thinking' : (extracted ? 'streaming' : 'receiving'),
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
    })()).map(value => f.next(value))))

export { llmInterpreterR }
