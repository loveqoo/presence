import fp from '../lib/fun-fp.js'
import { Interpreter } from './compose.js'

const { Task, Reader } = fp

// JSON 이스케이프 → 문자 변환 맵
const ESCAPE_MAP = Object.freeze({ n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/' })

// JSON 문자열 값에서 이스케이프를 해석하여 추출. 닫는 따옴표까지.
const decodeJsonStringValue = (text, start) => {
  let result = ''
  let pos = start
  while (pos < text.length) {
    const char = text[pos]
    if (char === '"') break
    if (char === '\\' && pos + 1 < text.length) {
      const escaped = text[pos + 1]
      if (escaped === 'u' && pos + 5 < text.length) {
        result += String.fromCharCode(parseInt(text.slice(pos + 2, pos + 6), 16))
        pos += 6
        continue
      }
      result += ESCAPE_MAP[escaped] ?? escaped
      pos += 2
      continue
    }
    result += char
    pos++
  }
  return result || null
}

// JSON이 부분적으로 도착해도 "message":"..." 내용을 점진적으로 보여준다.
const extractStreamingMessage = (accumulated) => {
  const marker = '"message":'
  const idx = accumulated.indexOf(marker)
  if (idx === -1) return null
  let start = idx + marker.length
  while (start < accumulated.length && accumulated[start] !== '"') start++
  if (start >= accumulated.length) return null
  return decodeJsonStringValue(accumulated, start + 1)
}

// Op의 context 배열을 messages에 합성
const buildMessages = (messages, context) => {
  if (!context || context.length === 0) return messages
  return [
    ...messages,
    { role: 'user', content: `참조 컨텍스트:\n${context.map((c, i) => `[${i + 1}] ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n')}` },
  ]
}

// 스트리밍 delta 핸들러 생성
const createDeltaHandler = (streamingUi) => {
  let lastUpdate = 0
  return ({ accumulated, reasoning }) => {
    const now = Date.now()
    if (now - lastUpdate < 50) return
    lastUpdate = now
    const extracted = extractStreamingMessage(accumulated)
    streamingUi.set({
      content: extracted || '',
      status: reasoning ? 'thinking' : (extracted ? 'streaming' : 'receiving'),
      length: accumulated.length,
    })
  }
}

// 스트리밍 경로 — streamingUi 활성 + tool_calls 아닌 경우
const handleStream = async (llm, streamingUi, messages, op, signal) => {
  streamingUi.set({ content: '', status: 'connecting' })
  const result = await llm.chatStream({
    messages, responseFormat: op.responseFormat, maxTokens: op.maxTokens,
    signal, onDelta: createDeltaHandler(streamingUi),
  })
  if (result.truncated) streamingUi.set({ content: '', status: 'truncated' })
  return result.content
}

// 비스트리밍 경로 — tool calls 포함
const handleChat = async (llm, streamingUi, messages, op, signal) => {
  const result = await llm.chat({ messages, tools: op.tools, responseFormat: op.responseFormat, maxTokens: op.maxTokens, signal })
  if (result.type === 'tool_calls') return { type: 'tool_calls', toolCalls: result.toolCalls }
  if (result.truncated) streamingUi.set({ content: '', status: 'truncated' })
  return result.content
}

// AskLLM Op 실행 — 스트리밍/비스트리밍 분기
const executeAskLLM = (llm, streamingUi, getAbortSignal, op) => {
  const messages = buildMessages(op.messages, op.context)
  const signal = getAbortSignal ? getAbortSignal() : undefined
  const useStream = streamingUi.isEnabled() && !op.tools && llm.chatStream
  return useStream
    ? handleStream(llm, streamingUi, messages, op, signal)
    : handleChat(llm, streamingUi, messages, op, signal)
}

const llmInterpreterR = Reader.asks(({ ST, llm, streamingUi, getAbortSignal }) =>
  new Interpreter(['AskLLM'], (op) =>
    ST.lift(Task.fromPromise(() =>
      executeAskLLM(llm, streamingUi, getAbortSignal, op)
    )()).map(value => op.next(value))))

export { llmInterpreterR }
