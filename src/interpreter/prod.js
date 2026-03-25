import fp from '../lib/fun-fp.js'
import { DelegateResult } from '../infra/agent-registry.js'
import { sendA2ATask } from '../infra/a2a-client.js'
import { getByPath, setByPathPure } from '../infra/state.js'
import { runFreeWithStateT } from '../core/op.js'

const { Task, Free, Maybe, StateT } = fp
const ST = StateT('task')

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

const createProdInterpreter = ({ llm, toolRegistry, reactiveState, agentRegistry, fetchFn, onApprove, getAbortSignal } = {}) => {
  // Mutable UI state reference — Parallel 브랜치 실행 중 null로 억제하여
  // 브랜치가 전역 UI 상태(_streaming, _toolResults, delegates.pending)를 오염시키지 않도록 함.
  let uiState = reactiveState

  const appendContext = (messages, context) => {
    if (!context || context.length === 0) return messages
    const ctxText = context
      .map((c, i) => `[${i + 1}] ${typeof c === 'string' ? c : JSON.stringify(c)}`)
      .join('\n')
    return [...messages, { role: 'user', content: `참조 컨텍스트:\n${ctxText}` }]
  }

  // interpret를 클로저로 참조 (Parallel, Delegate에서 재귀 실행 필요)
  const interpret = (functor) => {
    const handler = handlers[functor.tag]
    return handler ? handler(functor) : ST.lift(Task.rejected(new Error(`Unknown op: ${functor.tag}`)))
  }

  const handlers = {
    AskLLM: (f) =>
      ST.lift(Task.fromPromise(async () => {
        const messages = appendContext(f.messages, f.context)

        // 스트리밍: reactiveState가 있고 tool_calls가 아닌 경우
        const signal = getAbortSignal ? getAbortSignal() : undefined

        if (uiState && !f.tools && llm.chatStream) {
          uiState.set('_streaming', { content: '', status: 'connecting' })
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
                uiState.set('_streaming', {
                  content: extracted || '',
                  status: extracted ? 'streaming' : 'receiving',
                  length: accumulated.length,
                })
              },
            })
            return result.content
          } finally {
            // _streaming 정리는 agent의 finishSuccess/finishFailure에서 수행
          }
        }

        // 비스트리밍 폴백 (tool calls 포함)
        const result = await llm.chat({ messages, tools: f.tools, responseFormat: f.responseFormat, signal })
        return result.type === 'tool_calls'
          ? { type: 'tool_calls', toolCalls: result.toolCalls }
          : result.content
      })()).map(value => f.next(value)),

    ExecuteTool: (f) => {
      const tool = toolRegistry.get(f.name)
      if (!tool) return ST.of(f.next(`[ERROR] Unknown tool: ${f.name}`))
      if (!tool.handler) return ST.of(f.next(`[ERROR] Tool '${f.name}' has no handler`))
      return ST.lift(Task.fromPromise(() =>
        Promise.resolve(tool.handler(f.args))
          .catch(err => `[ERROR] ${f.name}: ${err.message}`)
      )())
        .map(result => {
          if (uiState) {
            const prev = uiState.get('_toolResults') || []
            uiState.set('_toolResults', [...prev, { tool: f.name, args: f.args, result }])
          }
          return f.next(result)
        })
    },

    Respond:  (f) => ST.of(f.next(f.message)),
    Approve:  (f) => onApprove
      ? ST.lift(Task.fromPromise(() => onApprove(f.description))()).map(approved => f.next(approved))
      : ST.of(f.next(true)),
    Observe:  (f) => ST.of(f.next({ source: f.source, data: f.data })),

    Delegate: (f) => {
      const maybeEntry = agentRegistry ? agentRegistry.get(f.target) : Maybe.Nothing()

      const runLocal = (entry) =>
        ST.lift(Task.fromPromise(() =>
          entry.run(f.task)
            .then(output => DelegateResult.completed(f.target, output, 'local'))
            .catch(e => DelegateResult.failed(f.target, e.message || String(e), 'local'))
        )()).map(r => f.next(r))

      const runRemote = (entry) =>
        ST.lift(Task.fromPromise(async () => {
          const result = await sendA2ATask(f.target, entry.endpoint, f.task, { fetchFn })
          if (result.status === 'submitted' && uiState) {
            const pending = uiState.get('delegates.pending') || []
            uiState.set('delegates.pending', [...pending, {
              target: f.target, taskId: result.taskId,
              endpoint: entry.endpoint, submittedAt: Date.now(),
            }])
          }
          return result
        })()).map(r => f.next(r))

      return Maybe.fold(
        () => ST.of(f.next(DelegateResult.failed(f.target, `Unknown agent: ${f.target}`))),
        entry =>
          entry.type === 'local' && entry.run ? runLocal(entry)
          : entry.type === 'remote' && entry.endpoint ? runRemote(entry)
          : ST.of(f.next(DelegateResult.failed(f.target, `Agent '${f.target}' has no run function or endpoint`))),
        maybeEntry,
      )
    },

    UpdateState: (f) =>
      ST.modify(s => setByPathPure(s, f.path, f.value))
        .chain(() => ST.get)
        .map(s => f.next(s)),

    GetState: (f) =>
      ST.gets(s => getByPath(s, f.path))
        .map(value => f.next(value)),

    Parallel: (f) => {
      const programs = f.programs || []
      if (programs.length === 0) return ST.of(f.next([]))
      return ST.get.chain(currentState =>
        ST.lift(Task.fromPromise(async () => {
          // UI side effect 억제: 브랜치가 _streaming/_toolResults/delegates.pending을 오염시키지 않음
          const savedUi = uiState
          uiState = null
          try {
            const settled = await Promise.allSettled(
              programs.map(p =>
                runFreeWithStateT(interpret, ST)(p)(currentState)
                  .then(([result]) => result)
              )
            )
            return settled.map(r =>
              r.status === 'fulfilled'
                ? { status: 'fulfilled', value: r.value }
                : { status: 'rejected', reason: r.reason?.message || String(r.reason) }
            )
          } finally {
            uiState = savedUi
          }
        })()).map(results => f.next(results))
      )
    },

    Spawn: (f) => ST.of(f.next(undefined)),
  }

  return { interpret, ST }
}

export { createProdInterpreter, extractStreamingMessage }
