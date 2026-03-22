import fp from '../lib/fun-fp.js'
import { DelegateResult } from '../infra/agent-registry.js'
import { sendA2ATask } from '../infra/a2a-client.js'

const { Task, Free, Maybe } = fp

/**
 * 스트리밍 중 direct_response의 message 필드 추출.
 * JSON이 부분적으로 도착해도 "message":"..." 내용을 점진적으로 보여준다.
 */
const extractStreamingMessage = (accumulated) => {
  const marker = '"message":'
  const idx = accumulated.indexOf(marker)
  if (idx === -1) return null

  // "message": "..." 에서 여는 따옴표 찾기
  let start = idx + marker.length
  while (start < accumulated.length && accumulated[start] !== '"') start++
  if (start >= accumulated.length) return null
  start++ // skip opening quote

  // JSON string escape 처리하면서 내용 추출
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
      break // end of message string
    } else {
      result += accumulated[i]
      i++
    }
  }

  return result || null
}

const createProdInterpreter = ({ llm, toolRegistry, state, agentRegistry, fetchFn, onApprove, getAbortSignal } = {}) => {
  const appendContext = (messages, context) => {
    if (!context || context.length === 0) return messages
    const ctxText = context
      .map((c, i) => `[${i + 1}] ${typeof c === 'string' ? c : JSON.stringify(c)}`)
      .join('\n')
    return [...messages, { role: 'user', content: `참조 컨텍스트:\n${ctxText}` }]
  }

  // interpreter를 클로저로 참조 (Parallel, Delegate에서 재귀 실행 필요)
  const interpret = (functor) => {
    const handler = handlers[functor.tag]
    return handler ? handler(functor) : Task.rejected(new Error(`Unknown op: ${functor.tag}`))
  }

  const handlers = {
    AskLLM: (f) =>
      Task.fromPromise(async () => {
        const messages = appendContext(f.messages, f.context)

        // 스트리밍: state가 있고 tool_calls가 아닌 경우
        const signal = getAbortSignal ? getAbortSignal() : undefined

        if (state && !f.tools && llm.chatStream) {
          state.set('_streaming', { content: '', status: 'connecting' })
          let lastUpdate = 0
          try {
            const result = await llm.chatStream({
              messages,
              responseFormat: f.responseFormat,
              signal,
              onDelta: ({ accumulated }) => {
                // 20fps 쓰로틀링
                const now = Date.now()
                if (now - lastUpdate < 50) return
                lastUpdate = now

                const extracted = extractStreamingMessage(accumulated)
                state.set('_streaming', {
                  content: extracted || '',
                  status: extracted ? 'streaming' : 'receiving',
                  length: accumulated.length,
                })
              },
            })
            return result.content
          } finally {
            // _streaming 정리는 agent의 finishSuccess/finishFailure에서 수행
            // retry 간 플리커 방지를 위해 여기서 null로 설정하지 않음
          }
        }

        // 비스트리밍 폴백 (tool calls 포함)
        const result = await llm.chat({ messages, tools: f.tools, responseFormat: f.responseFormat, signal })
        return result.type === 'tool_calls'
          ? { type: 'tool_calls', toolCalls: result.toolCalls }
          : result.content
      })().map(value => f.next(value)),

    ExecuteTool: (f) => {
      const tool = toolRegistry.get(f.name)
      if (!tool) return Task.rejected(new Error(`Unknown tool: ${f.name}`))
      if (!tool.handler) return Task.rejected(new Error(`Tool '${f.name}' has no handler`))
      return Task.fromPromise(() => Promise.resolve(tool.handler(f.args)))()
        .map(result => {
          if (state) {
            const prev = state.get('_toolResults') || []
            state.set('_toolResults', [...prev, { tool: f.name, args: f.args, result }])
          }
          return f.next(result)
        })
    },

    Respond:  (f) => Task.of(f.next(f.message)),
    Approve:  (f) => onApprove
      ? Task.fromPromise(() => onApprove(f.description))().map(approved => f.next(approved))
      : Task.of(f.next(true)),
    Observe:  (f) => Task.of(f.next({ source: f.source, data: f.data })),

    Delegate: (f) => {
      const maybeEntry = agentRegistry ? agentRegistry.get(f.target) : Maybe.Nothing()

      const runLocal = (entry) =>
        Task.fromPromise(() =>
          entry.run(f.task)
            .then(output => DelegateResult.completed(f.target, output, 'local'))
            .catch(e => DelegateResult.failed(f.target, e.message || String(e), 'local'))
        )().map(r => f.next(r))

      const runRemote = (entry) =>
        Task.fromPromise(async () => {
          const result = await sendA2ATask(f.target, entry.endpoint, f.task, { fetchFn })
          if (result.status === 'submitted' && state) {
            const pending = state.get('delegates.pending') || []
            state.set('delegates.pending', [...pending, {
              target: f.target, taskId: result.taskId,
              endpoint: entry.endpoint, submittedAt: Date.now(),
            }])
          }
          return result
        })().map(r => f.next(r))

      return Maybe.fold(
        () => Task.of(f.next(DelegateResult.failed(f.target, `Unknown agent: ${f.target}`))),
        entry =>
          entry.type === 'local' && entry.run ? runLocal(entry)
          : entry.type === 'remote' && entry.endpoint ? runRemote(entry)
          : Task.of(f.next(DelegateResult.failed(f.target, `Agent '${f.target}' has no run function or endpoint`))),
        maybeEntry,
      )
    },

    UpdateState: (f) => {
      if (state) { state.set(f.path, f.value); return Task.of(f.next(state.snapshot())) }
      return Task.of(f.next(undefined))
    },

    GetState: (f) =>
      Task.of(f.next(state ? state.get(f.path) : undefined)),

    Parallel: (f) => {
      const programs = f.programs || []
      if (programs.length === 0) return Task.of(f.next([]))
      return Task.fromPromise(async () => {
        const settled = await Promise.allSettled(
          programs.map(p => Free.runWithTask(interpret)(p))
        )
        return settled.map(r =>
          r.status === 'fulfilled'
            ? { status: 'fulfilled', value: r.value }
            : { status: 'rejected', reason: r.reason?.message || String(r.reason) }
        )
      })().map(results => f.next(results))
    },

    Spawn: (f) => Task.of(f.next(undefined)),
  }

  return interpret
}

export { createProdInterpreter, extractStreamingMessage }
