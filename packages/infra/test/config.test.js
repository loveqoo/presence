import { Config } from '@presence/infra/infra/config.js'
import { fromFile, loadUserMerged } from '@presence/infra/infra/config-loader.js'
import fp from '@presence/core/lib/fun-fp.js'
const { Maybe } = fp
const DEFAULTS = Config.DEFAULTS
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../../../test/lib/assert.js'

function makeTmpDir(suffix) {
  const dir = join(tmpdir(), `presence-config-${suffix}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeJson(dir, relativePath, data) {
  const fullPath = join(dir, relativePath)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, JSON.stringify(data))
}

async function run() {
  console.log('Config tests')

  // --- mergeConfig (순수) ---

  {
    const base = new Config({ a: 1, b: { x: 10, y: 20 } })
    const override = new Config({ b: { x: 99 }, c: 3 })
    const result = Config.merge(base, override)
    assert(result.a === 1, 'mergeConfig: base preserved')
    assert(result.b.x === 99, 'mergeConfig: nested override')
    assert(result.b.y === 20, 'mergeConfig: nested base preserved')
    assert(result.c === 3, 'mergeConfig: new key added')
  }

  {
    const result = Config.merge(new Config({ a: [1, 2] }), new Config({ a: [3] }))
    assert(result.a.length === 1, 'mergeConfig: array replaced (not merged)')
  }

  {
    const result = Config.merge(DEFAULTS, new Config({}))
    assert(result.llm.model === 'gpt-4o', 'mergeConfig: empty override → defaults')
    assert(result.maxIterations === 10, 'mergeConfig: default maxIterations')
  }

  // --- readConfigFile ---

  {
    const result = fromFile('/nonexistent/path.json')
    assert(Maybe.isNothing(result), 'readConfigFile missing: returns Nothing')
  }

  {
    const dir = makeTmpDir('read-valid')
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ llm: { model: 'local-model' } }))

    const result = fromFile(path)
    assert(Maybe.isJust(result), 'readConfigFile valid: returns Just')
    assert(result.value.llm.model === 'local-model', 'readConfigFile valid: parsed correctly')
    rmSync(dir, { recursive: true, force: true })
  }

  {
    const dir = makeTmpDir('read-bad')
    const path = join(dir, 'config.json')
    writeFileSync(path, '<<<not json>>>')

    const result = fromFile(path)
    assert(Maybe.isNothing(result), 'readConfigFile invalid JSON: returns Nothing')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- loadUserMergedConfig: username 필수 ---

  {
    let threw = false
    try { loadUserMerged() } catch { threw = true }
    assert(threw, 'loadUserMergedConfig: throws without username')
  }

  // --- loadUserMergedConfig: DEFAULTS만 (server.json/user config 없음) ---

  {
    const dir = makeTmpDir('user-defaults')
    mkdirSync(join(dir, 'users', 'test'), { recursive: true })
    const config = loadUserMerged('test', { basePath: dir })
    assert(config.llm.model === DEFAULTS.llm.model, 'loadUserMergedConfig no files: uses defaults')
    assert(config.maxIterations === 10, 'loadUserMergedConfig no files: default maxIterations')
    assert(config.scheduler.enabled === true, 'loadUserMergedConfig no files: scheduler enabled')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- loadUserMergedConfig: server.json → user config override 머지 체인 ---

  {
    const dir = makeTmpDir('user-merge')
    writeJson(dir, 'server.json', {
      llm: { baseUrl: 'http://localhost:8045/v1', model: 'base-model' },
      maxIterations: 5,
    })
    writeJson(dir, 'users/anthony/config.json', {
      llm: { model: 'override-model', apiKey: 'sk-test' },
      locale: 'en',
    })

    const config = loadUserMerged('anthony', { basePath: dir })
    assert(config.llm.baseUrl === 'http://localhost:8045/v1', 'merge chain: server.json baseUrl preserved')
    assert(config.llm.model === 'override-model', 'merge chain: user overrides model')
    assert(config.llm.apiKey === 'sk-test', 'merge chain: user adds apiKey')
    assert(config.maxIterations === 5, 'merge chain: server.json maxIterations preserved')
    assert(config.locale === 'en', 'merge chain: user overrides locale')
    assert(config.scheduler.enabled === true, 'merge chain: defaults still apply')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- MCP merge (Phase 22 Step A+B) ---

  {
    // 공용만 — 모두 server origin
    const dir = makeTmpDir('mcp-server-only')
    writeJson(dir, 'server.json', {
      mcp: [{ serverName: 'github', baseUrl: 'http://gh', enabled: true }],
    })
    mkdirSync(join(dir, 'users', 'bob'), { recursive: true })
    const config = loadUserMerged('bob', { basePath: dir })
    assert(config.mcp.length === 1, 'mcp merge: server only 1개')
    assert(config.mcp[0].origin === 'server', 'mcp merge: origin=server 태깅')
    assert(config.mcp[0].serverName === 'github', 'mcp merge: 원본 필드 보존')
    rmSync(dir, { recursive: true, force: true })
  }

  {
    // 공용 + 개인 (다른 이름) → 둘 다 유지
    const dir = makeTmpDir('mcp-both')
    writeJson(dir, 'server.json', {
      mcp: [{ serverName: 'github', baseUrl: 'http://gh', enabled: true }],
    })
    writeJson(dir, 'users/alice/config.json', {
      mcp: [{ serverName: 'my-db', baseUrl: 'http://db', enabled: true }],
    })
    const config = loadUserMerged('alice', { basePath: dir })
    assert(config.mcp.length === 2, 'mcp merge: 공용+개인 = 2개 (기존엔 user 만 남았음)')
    const origins = config.mcp.map(e => e.origin).sort()
    assert(origins[0] === 'server' && origins[1] === 'user',
      `mcp merge: server/user 둘 다 (got ${origins})`)
    rmSync(dir, { recursive: true, force: true })
  }

  {
    // 공용 + 개인 (같은 serverName) → 공용 우선, 개인 무시
    const dir = makeTmpDir('mcp-conflict')
    writeJson(dir, 'server.json', {
      mcp: [{ serverName: 'github', baseUrl: 'http://admin-gh', enabled: true, apiKey: 'ADMIN' }],
    })
    writeJson(dir, 'users/carol/config.json', {
      mcp: [{ serverName: 'github', baseUrl: 'http://my-gh', enabled: true, apiKey: 'PERSONAL' }],
    })
    const config = loadUserMerged('carol', { basePath: dir })
    assert(config.mcp.length === 1, 'mcp merge: 중복 이름 → 1개만')
    assert(config.mcp[0].origin === 'server', 'mcp merge: 공용 우선')
    assert(config.mcp[0].baseUrl === 'http://admin-gh',
      `mcp merge: 공용 정의 유지 (got ${config.mcp[0].baseUrl})`)
    assert(config.mcp[0].apiKey === 'ADMIN',
      'mcp merge: 공용 credential 우선 (user 의 PERSONAL override 차단)')
    rmSync(dir, { recursive: true, force: true })
  }

  {
    // 개인만 → user origin
    const dir = makeTmpDir('mcp-user-only')
    writeJson(dir, 'users/dan/config.json', {
      mcp: [{ serverName: 'my-mcp', baseUrl: 'http://local', enabled: true }],
    })
    const config = loadUserMerged('dan', { basePath: dir })
    assert(config.mcp.length === 1, 'mcp merge: user only 1개')
    assert(config.mcp[0].origin === 'user', 'mcp merge: origin=user 태깅')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- DEFAULTS shape ---

  {
    assert(DEFAULTS.llm.responseFormat === 'json_schema', 'DEFAULTS: responseFormat is json_schema')
    assert(DEFAULTS.llm.maxRetries === 2, 'DEFAULTS: maxRetries is 2')
    assert(DEFAULTS.llm.timeoutMs === 120_000, 'DEFAULTS: timeoutMs is 120000')
    assert(DEFAULTS.embed.dimensions === 256, 'DEFAULTS: embed dimensions')
    assert(Array.isArray(DEFAULTS.mcp), 'DEFAULTS: mcp is array')
    // docs §11.1 — a2a 기본값은 disabled. publicUrl null.
    assert(DEFAULTS.a2a.enabled === false, 'DEFAULTS: a2a.enabled=false')
    assert(DEFAULTS.a2a.publicUrl === null, 'DEFAULTS: a2a.publicUrl=null')
  }

  // --- a2a schema parsing ---

  {
    const parsed1 = Config.Schema.parse({
      ...DEFAULTS,
      a2a: { enabled: true, publicUrl: 'https://home.example' },
    })
    assert(parsed1.a2a.enabled === true, 'a2a parse: enabled=true')
    assert(parsed1.a2a.publicUrl === 'https://home.example', 'a2a parse: publicUrl round-trip')

    // a2a 생략 시 기본값 주입
    const { a2a: _omit, ...withoutA2a } = DEFAULTS
    const parsed2 = Config.Schema.parse(withoutA2a)
    assert(parsed2.a2a.enabled === false, 'a2a parse: omit → default enabled=false')
    assert(parsed2.a2a.publicUrl === null, 'a2a parse: omit → default publicUrl=null')
  }

  summary()
}

run()
