import {
  Free, askLLM, executeTool, respond, approve, delegate, observe, getState
} from './op.js'

// --- Reference resolution ---
const resolveRefs = (refs, results) => {
  if (!refs || !Array.isArray(refs)) return []
  return refs.map(i => results[i - 1]).filter(r => r !== undefined)
}

const resolveStringRefs = (str, results) => {
  if (typeof str !== 'string') return str
  return str.replace(/\$(\d+)/g, (_, n) => {
    const val = results[Number(n) - 1]
    return val !== undefined ? (typeof val === 'string' ? val : JSON.stringify(val)) : `$${n}`
  })
}

const resolveToolArgs = (args, results) => {
  if (!args || typeof args !== 'object') return args
  const resolved = {}
  for (const [k, v] of Object.entries(args)) {
    resolved[k] = typeof v === 'string' ? resolveStringRefs(v, results) : v
  }
  return resolved
}

// --- Step → Op ---
const stepToOp = (step, results) => {
  const a = step.args || {}
  switch (step.op) {
    case 'LOOKUP_MEMORY':
      return getState('context.memories').chain(memories => {
        if (!Array.isArray(memories) || memories.length === 0) return Free.of([])
        const q = (a.query || '').toLowerCase()
        if (!q) return Free.of(memories)
        return Free.of(memories.filter(m => String(m).toLowerCase().includes(q)))
      })
    case 'ASK_LLM': {
      const ctx = resolveRefs(a.ctx, results)
      return askLLM({
        messages: [{ role: 'user', content: a.prompt }],
        context: ctx.length > 0 ? ctx : undefined,
      })
    }
    case 'EXEC':
      return executeTool(a.tool, resolveToolArgs(a.tool_args, results))
    case 'RESPOND':
      return respond(a.ref != null ? results[a.ref - 1] : a.message)
    case 'APPROVE':
      return approve(a.description)
    case 'DELEGATE':
      return delegate(a.target, a.task)
    default:
      return Free.of(null)
  }
}

// --- parsePlan ---
const parsePlan = (plan) => {
  if (plan.type === 'direct_response') {
    return respond(plan.message)
  }

  const steps = plan.steps || []
  if (steps.length === 0) return Free.of([])

  return steps.reduce(
    (program, step) => program.chain(results =>
      stepToOp(step, results).chain(result =>
        Free.of([...results, result]))),
    Free.of([]))
}

export { parsePlan, stepToOp, resolveRefs, resolveStringRefs, resolveToolArgs }
