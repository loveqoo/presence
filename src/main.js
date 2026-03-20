import { createReactiveState } from './infra/state.js'
import { createToolRegistry } from './infra/tools.js'
import { createPersistence } from './infra/persistence.js'
import { createPersona } from './infra/persona.js'
import { createMemoryGraph, MemoryGraph } from './infra/memory.js'
import { createLogger } from './infra/logger.js'
import { LLMClient } from './infra/llm.js'
import { createProdInterpreter } from './interpreter/prod.js'
import { createTracedInterpreter } from './interpreter/traced.js'
import { createAgent } from './core/agent.js'
import { createRepl } from './core/repl.js'

const main = async () => {
  // --- Config ---
  const persona = createPersona()
  const personaConfig = persona.get()
  const { logger, setLevel } = createLogger()

  // --- State ---
  const state = createReactiveState({
    status: 'idle',
    turn: 0,
    currentInput: null,
    lastResult: null,
    lastError: null,
    context: { memories: [] },
  })

  // --- Memory ---
  const memory = await createMemoryGraph()

  // --- Memory hooks ---
  state.hooks.on('status', async (value, s) => {
    if (value === 'working') {
      const input = s.get('currentInput')
      if (input) {
        const memories = memory.recall(input)
        s.set('context.memories', memories.map(n => n.label))
      }
      s.set('turn', (s.get('turn') || 0) + 1)
    }
  })

  state.hooks.on('status', async (value, s) => {
    if (value === 'idle' && s.get('lastResult')) {
      memory.addNode({
        label: s.get('currentInput') || 'unknown',
        type: 'conversation',
        tier: 'episodic',
        data: { input: s.get('currentInput'), output: s.get('lastResult') },
      })
    }
  })

  // --- Persistence ---
  const persistence = createPersistence()
  persistence.connectToState(state)

  // --- Tools ---
  const toolRegistry = createToolRegistry()

  // --- LLM ---
  const llm = new LLMClient({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
  })

  // --- Interpreter ---
  const prodInterpreter = createProdInterpreter({ llm, toolRegistry, state })
  const { interpreter, trace } = createTracedInterpreter(prodInterpreter, { logger })

  // --- Agent ---
  const tools = persona.filterTools(toolRegistry.list())
  const agent = createAgent({
    tools,
    persona: personaConfig,
    interpreter,
    state,
  })

  // --- REPL ---
  const repl = createRepl({
    agent,
    onOutput: (result) => console.log(`\nAgent: ${result}\n`),
    onError: (err) => {
      logger.error('Turn failed', { error: err.message })
      console.error(`\nError: ${err.message}\n`)
    },
  })

  // --- Readline interface ---
  const { createInterface } = await import('readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log(`[${personaConfig.name}] Ready. Type /quit to exit.\n`)

  const prompt = () => {
    if (!repl.running) {
      rl.close()
      return
    }
    rl.question('> ', async (input) => {
      if (!input.trim()) { prompt(); return }
      await repl.handleInput(input.trim())
      prompt()
    })
  }

  prompt()
}

export { main }

// CLI 진입점
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^file:\/\//, ''))) {
  main().catch(err => {
    console.error('Fatal:', err)
    process.exit(1)
  })
}
