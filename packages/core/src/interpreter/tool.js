import fp from '../lib/fun-fp.js'
import { Interpreter } from './compose.js'

const { Task, Reader } = fp

// 에러는 문자열로 반환 (턴 계속 진행, LLM이 re-plan).
// getWorkingDir / resolvePath 는 선택 인자 — 없으면 context 에서 제외되어 기존 handler 호환.
const toolInterpreterR = Reader.asks((deps) => {
  const { ST, toolRegistry, userDataStore, toolResultUi, getWorkingDir, resolvePath } = deps
  return new Interpreter(['ExecuteTool'], (f) => {
    const tool = toolRegistry.get(f.name)
    if (!tool) return ST.of(f.next(`[ERROR] Unknown tool: ${f.name}`))
    if (!tool.handler) return ST.of(f.next(`[ERROR] Tool '${f.name}' has no handler`))
    // handler context: 세션 실행 컨텍스트의 subset (workingDir + resolvePath) 을 현재 값으로 주입.
    const ctx = {
      toolRegistry, userDataStore,
      workingDir: getWorkingDir ? getWorkingDir() : undefined,
      resolvePath,
    }
    return ST.lift(Task.fromPromise(() =>
      Promise.resolve(tool.handler(f.args, ctx))
        .catch(err => `[ERROR] ${f.name}: ${err.message}`)
    )())
      .map(result => {
        toolResultUi.append({ tool: f.name, args: f.args, result, ts: Date.now() })
        return f.next(result)
      })
  })
})

export { toolInterpreterR }
