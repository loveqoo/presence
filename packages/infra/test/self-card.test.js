import {
  buildSelfCard,
  buildSelfCardsFromRegistry,
  isCardEligible,
} from '@presence/infra/infra/agents/self-card.js'
import { createAgentRegistry } from '@presence/infra/infra/agents/agent-registry.js'
import { assert, summary } from '../../../test/lib/assert.js'

console.log('Self card tests')

// SC1. buildSelfCard — 최소 유효 입력
{
  const card = buildSelfCard({
    agentId: 'anthony/daily-report',
    publicUrl: 'https://home.example',
  })
  assert(card.name === 'anthony/daily-report', 'SC1: name = agentId')
  assert(card.url === 'https://home.example/a2a/anthony/daily-report', 'SC1: url 조립')
  assert(card['x-presence'].agentId === 'anthony/daily-report', 'SC1: x-presence.agentId')
  assert(Array.isArray(card['x-presence'].roles), 'SC1: x-presence.roles array')
  assert(card['x-presence'].roles.includes('owner'), 'SC1: owner role')
  assert(card.description === '', 'SC1: default description empty')
  assert(Array.isArray(card.capabilities) && card.capabilities.length === 0, 'SC1: default empty capabilities')
}

// SC2. description + capabilities 반영
{
  const card = buildSelfCard({
    agentId: 'alice/helper',
    publicUrl: 'https://alice.example',
    description: 'helper agent',
    capabilities: ['summarize', 'translate'],
  })
  assert(card.description === 'helper agent', 'SC2: description round-trip')
  assert(card.capabilities.length === 2, 'SC2: capabilities length')
  assert(card.capabilities[0] === 'summarize', 'SC2: capabilities content')
}

// SC3. publicUrl trailing slash 정규화
{
  const card = buildSelfCard({
    agentId: 'bob/default',
    publicUrl: 'https://bob.example/',
  })
  assert(card.url === 'https://bob.example/a2a/bob/default', 'SC3: trailing slash 제거')
}

// SC4. invalid agentId → throw
{
  let thrown = null
  try { buildSelfCard({ agentId: 'Invalid', publicUrl: 'https://x.com' }) } catch (e) { thrown = e }
  assert(thrown && /invalid agentId/.test(thrown.message), 'SC4: invalid agentId throw')
}

// SC5. publicUrl 누락 → throw
{
  let thrown = null
  try { buildSelfCard({ agentId: 'anthony/default' }) } catch (e) { thrown = e }
  assert(thrown && /publicUrl required/.test(thrown.message), 'SC5: publicUrl 누락 throw')
}

// SC6. isCardEligible — archived 제외
{
  assert(isCardEligible({ agentId: 'a/b', type: 'local' }) === true, 'SC6: local → true')
  assert(isCardEligible({ agentId: 'a/b', type: 'local', archived: true }) === false, 'SC6: archived → false')
  assert(isCardEligible({ agentId: 'a/b', type: 'remote' }) === false, 'SC6: remote → false')
  assert(isCardEligible(null) === false, 'SC6: null → false')
}

// SC7. buildSelfCardsFromRegistry — registry 전체 → 카드 목록
{
  const reg = createAgentRegistry()
  reg.register({ agentId: 'anthony/default', type: 'local', description: 'main' })
  reg.register({ agentId: 'anthony/helper', type: 'local', description: 'assistant' })
  reg.register({ agentId: 'anthony/old', type: 'local', archived: true })
  reg.register({ agentId: 'anthony/remote-peer', type: 'remote', endpoint: 'https://elsewhere' })

  const cards = buildSelfCardsFromRegistry(reg, 'https://home.example')
  assert(cards.length === 2, `SC7: 2 카드 (archived + remote 제외, got ${cards.length})`)
  const ids = cards.map(c => c['x-presence'].agentId).sort()
  assert(ids[0] === 'anthony/default' && ids[1] === 'anthony/helper', 'SC7: 올바른 agent 만')
  assert(cards[0].url.startsWith('https://home.example/a2a/'), 'SC7: url prefix')
}

// SC8. buildSelfCardsFromRegistry — registry 없음 → 빈 배열
{
  assert(buildSelfCardsFromRegistry(null, 'https://x.com').length === 0, 'SC8: null registry → []')
  assert(buildSelfCardsFromRegistry({}, 'https://x.com').length === 0, 'SC8: registry 모양 불일치 → []')
}

summary()
