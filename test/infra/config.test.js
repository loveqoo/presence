import { Config } from '@presence/infra/infra/config.js'
import fp from '@presence/core/lib/fun-fp.js'
const { Maybe } = fp
const DEFAULTS = Config.DEFAULTS
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../lib/assert.js'

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
    const result = Config.fromFile('/nonexistent/path.json')
    assert(Maybe.isNothing(result), 'readConfigFile missing: returns Nothing')
  }

  {
    const dir = makeTmpDir('read-valid')
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ llm: { model: 'local-model' } }))

    const result = Config.fromFile(path)
    assert(Maybe.isJust(result), 'readConfigFile valid: returns Just')
    assert(result.value.llm.model === 'local-model', 'readConfigFile valid: parsed correctly')
    rmSync(dir, { recursive: true, force: true })
  }

  {
    const dir = makeTmpDir('read-bad')
    const path = join(dir, 'config.json')
    writeFileSync(path, '<<<not json>>>')

    const result = Config.fromFile(path)
    assert(Maybe.isNothing(result), 'readConfigFile invalid JSON: returns Nothing')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- loadUserMergedConfig: username 필수 ---

  {
    let threw = false
    try { Config.loadUserMerged() } catch { threw = true }
    assert(threw, 'loadUserMergedConfig: throws without username')
  }

  // --- loadUserMergedConfig: DEFAULTS만 (server.json/user config 없음) ---

  {
    const dir = makeTmpDir('user-defaults')
    mkdirSync(join(dir, 'users', 'test'), { recursive: true })
    const config = Config.loadUserMerged('test', { basePath: dir })
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

    const config = Config.loadUserMerged('anthony', { basePath: dir })
    assert(config.llm.baseUrl === 'http://localhost:8045/v1', 'merge chain: server.json baseUrl preserved')
    assert(config.llm.model === 'override-model', 'merge chain: user overrides model')
    assert(config.llm.apiKey === 'sk-test', 'merge chain: user adds apiKey')
    assert(config.maxIterations === 5, 'merge chain: server.json maxIterations preserved')
    assert(config.locale === 'en', 'merge chain: user overrides locale')
    assert(config.scheduler.enabled === true, 'merge chain: defaults still apply')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- DEFAULTS shape ---

  {
    assert(DEFAULTS.llm.responseFormat === 'json_schema', 'DEFAULTS: responseFormat is json_schema')
    assert(DEFAULTS.llm.maxRetries === 2, 'DEFAULTS: maxRetries is 2')
    assert(DEFAULTS.llm.timeoutMs === 120_000, 'DEFAULTS: timeoutMs is 120000')
    assert(DEFAULTS.embed.dimensions === 256, 'DEFAULTS: embed dimensions')
    assert(Array.isArray(DEFAULTS.mcp), 'DEFAULTS: mcp is array')
  }

  summary()
}

run()
