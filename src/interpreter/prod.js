import fp from '../lib/fun-fp.js'
import { DelegateResult } from '../infra/agent-registry.js'
import { sendA2ATask } from '../infra/a2a-client.js'

const { Task, Free, Maybe } = fp

const createProdInterpreter = ({ llm, toolRegistry, state, agentRegistry, fetchFn, onApprove } = {}) => {
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
        const result = await llm.chat({ messages, tools: f.tools, responseFormat: f.responseFormat })
        return result.type === 'tool_calls'
          ? { type: 'tool_calls', toolCalls: result.toolCalls }
          : result.content
      })().map(value => f.next(value)),

    ExecuteTool: (f) => {
      const tool = toolRegistry.get(f.name)
      if (!tool) return Task.rejected(new Error(`Unknown tool: ${f.name}`))
      if (!tool.handler) return Task.rejected(new Error(`Tool '${f.name}' has no handler`))
      return Task.fromPromise(() => Promise.resolve(tool.handler(f.args)))()
        .map(result => f.next(result))
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

export { createProdInterpreter }
