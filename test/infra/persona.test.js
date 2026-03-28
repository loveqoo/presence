import { createPersona, DEFAULT_PERSONA } from '@presence/infra/infra/persona.js'
import { buildIterationPrompt } from '@presence/core/core/prompt.js'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../lib/assert.js'

function run() {
  console.log('Persona config tests')

  const testDir = join(tmpdir(), `presence-persona-test-${Date.now()}`)
  mkdirSync(testDir, { recursive: true })
  let testNum = 0
  const makeCwd = () => {
    const cwd = join(testDir, `t${++testNum}`)
    mkdirSync(cwd, { recursive: true })
    return cwd
  }

  // 1. Default persona when no config exists
  {
    const persona = createPersona({ cwd: makeCwd() })
    persona.reset()
    const p = persona.get()
    assert(p.name === 'Presence', 'default: name is Presence')
    assert(p.systemPrompt === null, 'default: systemPrompt is null')
    assert(Array.isArray(p.rules) && p.rules.length === 0, 'default: empty rules')
    assert(Array.isArray(p.tools) && p.tools.length === 0, 'default: empty tools')
  }

  // 2. Custom systemPrompt
  {
    const persona = createPersona({ cwd: makeCwd() })
    persona.set({ systemPrompt: '나는 개인 비서다.' })
    const p = persona.get()
    assert(p.systemPrompt === '나는 개인 비서다.', 'custom: systemPrompt set')

    const prompt = buildIterationPrompt({
      tools: [], memories: [], input: 'test',
      persona: p
    })
    assert(prompt.messages[0].content.includes('나는 개인 비서다'), 'custom: reflected in prompt')
  }

  // 3. Rules reflected in prompt
  {
    const persona = createPersona({ cwd: makeCwd() })
    persona.set({ rules: ['항상 한국어로 답해', '보안 우선'] })
    const p = persona.get()

    const prompt = buildIterationPrompt({
      tools: [], memories: [], input: 'test',
      persona: p
    })
    assert(prompt.messages[0].content.includes('항상 한국어로 답해'), 'rules: first rule in prompt')
    assert(prompt.messages[0].content.includes('보안 우선'), 'rules: second rule in prompt')
  }

  // 4. Tools whitelist
  {
    const persona = createPersona({ cwd: makeCwd() })
    persona.set({ tools: ['github_list_prs'] })

    const allTools = [
      { name: 'github_list_prs', description: 'PR' },
      { name: 'slack_send', description: 'Slack' },
      { name: 'jira_issues', description: 'Jira' },
    ]

    const filtered = persona.filterTools(allTools)
    assert(filtered.length === 1, 'whitelist: only 1 tool')
    assert(filtered[0].name === 'github_list_prs', 'whitelist: correct tool')
  }

  // 5. Empty tools whitelist → all tools allowed
  {
    const persona = createPersona({ cwd: makeCwd() })
    persona.reset()

    const allTools = [{ name: 'a' }, { name: 'b' }]
    const filtered = persona.filterTools(allTools)
    assert(filtered.length === 2, 'empty whitelist: all tools')
  }

  // 6. Set updates without overwriting
  {
    const persona = createPersona({ cwd: makeCwd() })
    persona.set({ name: 'MyAgent', rules: ['rule1'] })
    persona.set({ rules: ['rule1', 'rule2'] })
    const p = persona.get()
    assert(p.name === 'MyAgent', 'partial set: name preserved')
    assert(p.rules.length === 2, 'partial set: rules updated')
  }

  // Cleanup
  rmSync(testDir, { recursive: true, force: true })

  summary()
}

run()
