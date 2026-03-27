/**
 * Debug Report Builder
 *
 * /report 커맨드에서 호출. state 데이터를 읽어
 * 사람과 LLM 모두 이해할 수 있는 마크다운 리포트를 생성한다.
 */

const formatDuration = (ms) => {
  if (ms == null) return '?'
  if (ms < 1) return '< 1ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const formatTimestamp = (ts) => {
  if (!ts) return '?'
  const d = new Date(ts)
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

const truncate = (str, max = 200) => {
  if (!str) return '(none)'
  const s = String(str)
  return s.length > max ? s.slice(0, max) + `... (${s.length} chars total)` : s
}

const buildReport = ({ debug, opTrace, iterationHistory, lastPrompt, lastResponse, state, config }) => {
  const lines = []
  const add = (line = '') => lines.push(line)

  const now = new Date()
  add('# Presence Debug Report')
  add(`**Generated:** ${now.toISOString()}`)
  add()

  // --- Turn Info ---
  add('## Turn')
  if (debug) {
    add(`- **Input:** \`${truncate(debug.input, 100)}\``)
    add(`- **Result:** ${debug.parsedType || 'unknown'}`)
    add(`- **Iteration:** ${debug.iteration ?? '?'}`)
    add(`- **Error:** ${debug.error || 'none'}`)
    add(`- **Timestamp:** ${formatTimestamp(debug.timestamp)}`)
  } else {
    add('(no turn data)')
  }
  add()

  // --- Op Timeline ---
  if (opTrace && opTrace.length > 0) {
    let totalMs = 0, maxDur = 0
    for (const e of opTrace) { const d = e.duration || 0; totalMs += d; if (d > maxDur) maxDur = d }
    add(`## Timeline (${opTrace.length} ops, ${formatDuration(totalMs)})`)
    add('```')
    add(`${'#'.padStart(3)} ${'Op'.padEnd(35)} ${'Duration'.padStart(10)} Status`)
    add(`${'─'.repeat(3)} ${'─'.repeat(35)} ${'─'.repeat(10)} ${'─'.repeat(20)}`)
    for (let i = 0; i < opTrace.length; i++) {
      const e = opTrace[i]
      const idx = String(i + 1).padStart(3)
      const label = e.detail ? `${e.tag}(${e.detail})` : (e.tag || '?')
      const tag = label.length > 35 ? label.slice(0, 32) + '...' : label.padEnd(35)
      const dur = formatDuration(e.duration).padStart(10)
      const isSlowest = e.duration === maxDur && maxDur > 10 && opTrace.length > 2
      const status = e.error
        ? `ERROR: ${e.error}`
        : isSlowest ? 'done (slowest)' : 'done'
      add(`${idx} ${tag} ${dur} ${status}`)
    }
    add('```')
  } else {
    add('## Timeline')
    add('(no op trace)')
  }
  add()

  // --- Iteration History ---
  if (iterationHistory && iterationHistory.length > 0) {
    add(`## Iterations (${iterationHistory.length})`)
    for (const iter of iterationHistory) {
      add()
      add(`### Iteration ${iter.iteration + 1}`)
      add(`- **Parsed type:** ${iter.parsedType || 'unknown'}`)
      add(`- **Step count:** ${iter.stepCount ?? '?'}`)
      if (iter.error) add(`- **Error:** ${iter.error}`)
      add(`- **Assembly used:** ${iter.assembly?.used ?? '?'} tokens`)
      if (iter.promptMessages > 0) {
        add(`- **Prompt:** ${iter.promptMessages} messages, ${iter.promptChars} chars`)
      }
      if (iter.response) {
        add(`- **Response (${iter.response.length} chars):**`)
        add('```json')
        add(iter.response.length > 500 ? iter.response.slice(0, 500) + '\n... (truncated)' : iter.response)
        add('```')
      }
    }
    add()
  }

  // --- Assembly ---
  const assembly = debug?.assembly
  if (assembly) {
    const pct = assembly.budget && assembly.budget !== Infinity
      ? ` (${Math.round(assembly.used / assembly.budget * 100)}%)`
      : ''
    add('## Assembly')
    add(`- **Budget:** ${assembly.budget === Infinity ? 'unlimited' : assembly.budget + ' tokens'}`)
    add(`- **Used:** ${assembly.used} tokens${pct}`)
    add(`- **History:** ${assembly.historyUsed} used, ${assembly.historyDropped} dropped`)
    add(`- **Memories:** ${assembly.memoriesUsed} recalled`)
    add()
  }

  // --- Prompt ---
  if (lastPrompt && lastPrompt.length > 0) {
    const totalChars = lastPrompt.reduce((s, m) => s + (m.content?.length || 0), 0)
    add(`## Prompt (${lastPrompt.length} messages, ${totalChars} chars)`)
    add('```')
    for (let i = 0; i < lastPrompt.length; i++) {
      const m = lastPrompt[i]
      const body = m.content || ''
      const nl = body.indexOf('\n')
      const firstLine = nl === -1 ? body : body.slice(0, nl)
      add(`[${i}] ${m.role} (${body.length} chars): ${truncate(firstLine, 120)}`)
    }
    add('```')
    add()
  }

  // --- LLM Response ---
  if (lastResponse) {
    add(`## LLM Response (${lastResponse.length} chars)`)
    add('```json')
    add(lastResponse.length > 2000 ? lastResponse.slice(0, 2000) + '\n... (truncated)' : lastResponse)
    add('```')
    add()
  }

  // --- Recalled Memories ---
  const memories = debug?.memories || []
  if (memories.length > 0) {
    add(`## Recalled Memories (${memories.length})`)
    for (let i = 0; i < memories.length; i++) {
      add(`${i + 1}. ${truncate(String(memories[i]), 100)}`)
    }
    add()
  }

  // --- State Summary ---
  if (state) {
    add('## State')
    const turnState = state.get('turnState')
    const lastTurn = state.get('lastTurn')
    const turn = state.get('turn') || 0
    const mems = state.get('context.memories') || []
    const history = state.get('context.conversationHistory') || []
    add(`- **Turn:** ${turn}`)
    add(`- **Status:** ${turnState?.tag || '?'}`)
    add(`- **Last Result:** ${lastTurn?.tag || 'none'}`)
    add(`- **Memories:** ${mems.length} recalled`)
    add(`- **History:** ${history.length} entries`)
    add()
  }

  // --- Config ---
  if (config) {
    add('## Config')
    add(`- **Model:** ${config.llm?.model || '?'}`)
    add(`- **Base URL:** ${config.llm?.baseUrl || '?'}`)
    add(`- **Response Format:** ${config.llm?.responseFormat || '?'}`)
    add(`- **Max Retries:** ${config.llm?.maxRetries ?? '?'}`)
    add(`- **Max Iterations:** ${config.maxIterations ?? '?'}`)
    add(`- **Embedder:** ${config.embed?.baseUrl || config.embed?.apiKey ? 'active' : 'none'}`)
    add()
  }

  // --- System ---
  add('## System')
  add(`- **Node:** ${process.version}`)
  add(`- **Platform:** ${process.platform} ${process.arch}`)
  add(`- **Generated:** ${now.toISOString()}`)

  return lines.join('\n')
}

export { buildReport, formatDuration, formatTimestamp, truncate }
