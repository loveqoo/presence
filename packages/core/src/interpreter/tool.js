import fp from '../lib/fun-fp.js'
import { Interpreter } from './compose.js'

const { Task, Reader } = fp

// 에러는 문자열로 반환 (턴 계속 진행, LLM이 re-plan).
const toolInterpreterR = Reader.asks(({ ST, toolRegistry, userDataStore, toolResultUi }) =>
  new Interpreter(['ExecuteTool'], (f) => {
    const tool = toolRegistry.get(f.name)
    if (!tool) return ST.of(f.next(`[ERROR] Unknown tool: ${f.name}`))
    if (!tool.handler) return ST.of(f.next(`[ERROR] Tool '${f.name}' has no handler`))
    return ST.lift(Task.fromPromise(() =>
      Promise.resolve(tool.handler(f.args, { toolRegistry, userDataStore }))
        .catch(err => `[ERROR] ${f.name}: ${err.message}`)
    )())
      .map(result => {
        toolResultUi.append({ tool: f.name, args: f.args, result, ts: Date.now() })
        return f.next(result)
      })
  }))

export { toolInterpreterR }
