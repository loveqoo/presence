import { createToolRegistry } from '@presence/infra/infra/tools/tool-registry.js'
import { assert, summary } from '../lib/assert.js'

console.log('Tool registry tests')

const registry = createToolRegistry()

// 1. Register + get
registry.register({
  name: 'github_list_prs',
  description: 'GitHub PR 목록 조회',
  parameters: {
    type: 'object',
    required: ['repo'],
    properties: {
      repo: { type: 'string', description: '저장소' },
      state: { type: 'string', enum: ['open', 'closed', 'all'] },
    }
  }
})

const tool = registry.get('github_list_prs')
assert(tool !== null, 'get: returns registered tool')
assert(tool.name === 'github_list_prs', 'get: correct name')

// 2. Register second tool
registry.register({
  name: 'slack_send',
  description: '슬랙 메시지 발송',
  parameters: {
    type: 'object',
    required: ['channel', 'message'],
    properties: {
      channel: { type: 'string' },
      message: { type: 'string' },
    }
  }
})

// 3. list
const list = registry.list()
assert(list.length === 2, 'list: 2 tools registered')
assert(list.some(t => t.name === 'github_list_prs'), 'list: includes github tool')
assert(list.some(t => t.name === 'slack_send'), 'list: includes slack tool')

// 4. get unknown tool
assert(registry.get('unknown') === null, 'get unknown: returns null')

// 5. schema
const names = registry.schema()
assert(names.length === 2, 'schema: 2 names')
assert(names.includes('github_list_prs'), 'schema: includes github')
assert(names.includes('slack_send'), 'schema: includes slack')

summary()
