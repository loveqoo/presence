import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Config } from '@presence/infra/infra/config.js'
import {
  ensureUserDefaultAgent,
  ensureUserDefaultAgentR,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_PERSONA,
} from '@presence/infra/infra/user-migration.js'
import { assert, summary } from '../../../test/lib/assert.js'

const createTmpDir = () => {
  const dir = join(tmpdir(), `presence-user-mig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

const writeUserConfig = (dir, username, data) => {
  const userDir = join(dir, 'users', username)
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, 'config.json'), JSON.stringify(data, null, 2))
}

const readUserConfig = (dir, username) => {
  return JSON.parse(readFileSync(join(dir, 'users', username, 'config.json'), 'utf-8'))
}

// ensureAllowedDirs 패턴과 동일 — config 객체를 필요로 함. 실제 migration 은 파일 기반.
const dummyConfig = new Config({
  llm: { baseUrl: 'x', model: 'x', apiKey: null, responseFormat: 'json_schema', maxRetries: 0, timeoutMs: 1000 },
  embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
  locale: 'ko', maxIterations: 1, memory: { path: null }, mcp: [],
  scheduler: { enabled: false, pollIntervalMs: 1000, todoReview: { enabled: false, cron: '' } },
  delegatePolling: { intervalMs: 1000 },
  agents: [], prompt: { maxContextTokens: 1000, reservedOutputTokens: 100, maxContextChars: null, reservedOutputChars: null },
  tools: { allowedDirs: ['/tmp'] },
})

function run() {
  console.log('User migration tests')

  // UM1. Fresh user — config.json 없음 → 파일 생성 + primaryAgentId + default agent
  {
    const dir = createTmpDir()
    const result = ensureUserDefaultAgent(dummyConfig, {
      username: 'alice', basePath: dir, logger: silentLogger,
    })

    assert(result.migrated === true, 'UM1: migrated=true')
    assert(result.primaryAgentId === 'alice/default', 'UM1: primaryAgentId=alice/default')

    const file = readUserConfig(dir, 'alice')
    assert(file.primaryAgentId === 'alice/default', 'UM1: file.primaryAgentId')
    assert(Array.isArray(file.agents) && file.agents.length === 1, 'UM1: 1 agent')
    assert(file.agents[0].name === DEFAULT_AGENT_NAME, 'UM1: default agent')
    assert(typeof file.agents[0].persona === 'object', 'UM1: persona object')
    assert(file.agents[0].persona.name === DEFAULT_AGENT_PERSONA.name, 'UM1: persona.name = Presence')
    assert(file.agents[0].archived === false, 'UM1: archived=false')
    assert(file.agents[0].createdBy === 'user-migration', 'UM1: createdBy stamp')

    rmSync(dir, { recursive: true, force: true })
  }

  // UM2. Idempotent — 두 번째 호출 시 no-op
  {
    const dir = createTmpDir()
    ensureUserDefaultAgent(dummyConfig, { username: 'bob', basePath: dir, logger: silentLogger })
    const before = readUserConfig(dir, 'bob')
    const result = ensureUserDefaultAgent(dummyConfig, { username: 'bob', basePath: dir, logger: silentLogger })
    const after = readUserConfig(dir, 'bob')

    assert(result.migrated === false, 'UM2: migrated=false (already)')
    assert(result.reason === 'already', 'UM2: reason=already')
    assert(before.agents[0].createdAt === after.agents[0].createdAt, 'UM2: createdAt 변경 없음 (파일 rewrite 안함)')

    rmSync(dir, { recursive: true, force: true })
  }

  // UM3. 기존 config 보존 — 다른 필드/agent 가 유지됨
  {
    const dir = createTmpDir()
    writeUserConfig(dir, 'carol', {
      tools: { allowedDirs: ['/Users/carol'] },
      locale: 'en',
      agents: [{ name: 'legacy', description: 'old', capabilities: [], archived: false }],
    })

    const result = ensureUserDefaultAgent(dummyConfig, { username: 'carol', basePath: dir, logger: silentLogger })
    assert(result.migrated === true, 'UM3: migrated=true')

    const file = readUserConfig(dir, 'carol')
    assert(file.locale === 'en', 'UM3: locale 보존')
    assert(file.tools.allowedDirs[0] === '/Users/carol', 'UM3: allowedDirs 보존')
    assert(file.agents.length === 2, 'UM3: legacy + default 둘 다')
    assert(file.agents.some(a => a.name === 'legacy'), 'UM3: legacy 유지')
    assert(file.agents.some(a => a.name === DEFAULT_AGENT_NAME), 'UM3: default 추가')
    assert(file.primaryAgentId === 'carol/default', 'UM3: primaryAgentId 설정')

    rmSync(dir, { recursive: true, force: true })
  }

  // UM4. 부분 완료 — default agent 는 있지만 primaryAgentId 만 누락 → primary 만 보충 (agent 중복 push 없음)
  {
    const dir = createTmpDir()
    writeUserConfig(dir, 'dave', {
      agents: [{
        name: DEFAULT_AGENT_NAME,
        description: 'existing',
        capabilities: [],
        persona: { name: 'Custom' },
        archived: false,
      }],
    })

    const result = ensureUserDefaultAgent(dummyConfig, { username: 'dave', basePath: dir, logger: silentLogger })
    assert(result.migrated === true, 'UM4: migrated=true (primaryAgentId 보충)')

    const file = readUserConfig(dir, 'dave')
    assert(file.agents.length === 1, 'UM4: agent 중복 push 없음')
    assert(file.agents[0].persona.name === 'Custom', 'UM4: 기존 persona 보존')
    assert(file.primaryAgentId === 'dave/default', 'UM4: primaryAgentId 보충')

    rmSync(dir, { recursive: true, force: true })
  }

  // UM5. Admin skip — admin-bootstrap 이 처리하므로 user-migration 은 no-op
  {
    const dir = createTmpDir()
    const result = ensureUserDefaultAgent(dummyConfig, { username: 'admin', basePath: dir, logger: silentLogger })
    assert(result.migrated === false, 'UM5: admin → migrated=false')
    assert(result.reason === 'admin', 'UM5: reason=admin')
    // 파일 생성 안됨
    const configPath = join(dir, 'users', 'admin', 'config.json')
    assert(!existsSync(configPath), 'UM5: admin config 파일 생성 안됨')

    rmSync(dir, { recursive: true, force: true })
  }

  // UM6. username 누락 → throw
  {
    let thrown = null
    try {
      ensureUserDefaultAgent(dummyConfig, { basePath: '/tmp', logger: silentLogger })
    } catch (e) { thrown = e }
    assert(thrown && /username required/.test(thrown.message), 'UM6: username 누락 throw')
  }

  // UM7. Atomic write — 정상 실행 후 tmp 잔여 없음
  {
    const dir = createTmpDir()
    ensureUserDefaultAgent(dummyConfig, { username: 'eve', basePath: dir, logger: silentLogger })
    const userDir = join(dir, 'users', 'eve')
    const tmp = readdirSync(userDir).filter(f => f.includes('.tmp-'))
    assert(tmp.length === 0, `UM7: tmp 잔여 없음 (${tmp.join(',')})`)

    rmSync(dir, { recursive: true, force: true })
  }

  // UM8. 레거시 브릿지 ↔ Reader 동치
  {
    const deps = { config: dummyConfig, username: 'frank', basePath: createTmpDir(), logger: silentLogger }
    const viaBridge = ensureUserDefaultAgent(deps.config, {
      username: deps.username, basePath: deps.basePath, logger: deps.logger,
    })
    // 재실행은 idempotent → 두 번째 호출은 migrated=false
    const viaReader = ensureUserDefaultAgentR.run(deps)()
    assert(viaBridge.migrated === true && viaReader.migrated === false, 'UM8: 브릿지는 첫 실행 migrated=true, Reader 재실행은 false (idempotent)')
    rmSync(deps.basePath, { recursive: true, force: true })
  }

  summary()
}

run()
