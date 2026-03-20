import fp from '../lib/fun-fp.js'

const { Task } = fp

const createProdInterpreter = ({ llm, toolRegistry, state }) => {
  return (functor) => {
    const { tag } = functor

    switch (tag) {
      case 'AskLLM':
        return Task.fromPromise(async () => {
          const result = await llm.chat({
            messages: functor.messages,
            tools: functor.tools,
            responseFormat: functor.responseFormat,
          })
          return result.content
        })().map(content => functor.next(content))

      case 'ExecuteTool': {
        const tool = toolRegistry.get(functor.name)
        if (!tool) {
          return Task.rejected(new Error(`Unknown tool: ${functor.name}`))
        }
        if (!tool.handler) {
          return Task.rejected(new Error(`Tool '${functor.name}' has no handler`))
        }
        return Task.fromPromise(() => Promise.resolve(tool.handler(functor.args)))()
          .map(result => functor.next(result))
      }

      case 'Respond':
        return Task.of(functor.next(functor.message))

      case 'Approve':
        // Phase 1: auto-approve. Phase 2+: 사용자 입력 대기
        return Task.of(functor.next(true))

      case 'Delegate':
        // Phase 5: A2A. 현재는 미구현 응답
        return Task.of(functor.next({ delegated: functor.target, status: 'not_implemented' }))

      case 'Observe':
        return Task.of(functor.next({ source: functor.source, data: functor.data }))

      case 'UpdateState':
        if (state) {
          state.set(functor.path, functor.value)
          return Task.of(functor.next(state.snapshot()))
        }
        return Task.of(functor.next(undefined))

      case 'GetState':
        if (state) {
          return Task.of(functor.next(state.get(functor.path)))
        }
        return Task.of(functor.next(undefined))

      case 'Parallel': {
        const programs = functor.programs || []
        // 순차 실행 (Phase 2+에서 Promise.all로 변경 가능)
        return Task.fromPromise(async () => {
          const results = []
          for (const p of programs) results.push(p)
          return results
        })().map(results => functor.next(results))
      }

      case 'Spawn':
        return Task.of(functor.next(undefined))

      default:
        return Task.rejected(new Error(`Unknown op: ${tag}`))
    }
  }
}

export { createProdInterpreter }
