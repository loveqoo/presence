import { loadConfig, mergeConfig, readConfigFile, DEFAULTS } from '@presence/infra/infra/config.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../lib/assert.js'

async function run() {
  console.log('Config tests')

  // --- mergeConfig (순수) ---

  {
    const base = { a: 1, b: { x: 10, y: 20 } }
    const override = { b: { x: 99 }, c: 3 }
    const result = mergeConfig(base, override)
    assert(result.a === 1, 'mergeConfig: base preserved')
    assert(result.b.x === 99, 'mergeConfig: nested override')
    assert(result.b.y === 20, 'mergeConfig: nested base preserved')
    assert(result.c === 3, 'mergeConfig: new key added')
  }

  {
    const result = mergeConfig({ a: [1, 2] }, { a: [3] })
    assert(result.a.length === 1, 'mergeConfig: array replaced (not merged)')
  }

  {
    const result = mergeConfig(DEFAULTS, {})
    assert(result.llm.model === 'gpt-4o', 'mergeConfig: empty override → defaults')
    assert(result.maxIterations === 10, 'mergeConfig: default maxIterations')
  }

  // --- readConfigFile ---

  {
    const result = readConfigFile('/nonexistent/path.json')
    assert(typeof result === 'object', 'readConfigFile missing: returns empty object')
    assert(Object.keys(result).length === 0, 'readConfigFile missing: no keys')
  }

  {
    const dir = join(tmpdir(), `presence-config-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ llm: { model: 'local-model' } }))

    const result = readConfigFile(path)
    assert(result.llm.model === 'local-model', 'readConfigFile valid: parsed correctly')
    rmSync(dir, { recursive: true, force: true })
  }

  {
    const dir = join(tmpdir(), `presence-config-bad-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'config.json')
    writeFileSync(path, '<<<not json>>>')

    const result = readConfigFile(path)
    assert(Object.keys(result).length === 0, 'readConfigFile invalid JSON: returns empty')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- loadConfig ---

  {
    const config = loadConfig('/nonexistent/config.json')
    assert(config.llm.model === DEFAULTS.llm.model, 'loadConfig no file: uses defaults')
    assert(config.maxIterations === 10, 'loadConfig no file: default maxIterations')
    assert(config.scheduler.enabled === true, 'loadConfig no file: scheduler enabled')
  }

  {
    const dir = join(tmpdir(), `presence-config-load-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({
      llm: { baseUrl: 'http://localhost:8045/v1', model: 'qwen3.5-35b', responseFormat: 'json_object' },
      maxIterations: 5,
    }))

    const config = loadConfig(path)
    assert(config.llm.baseUrl === 'http://localhost:8045/v1', 'loadConfig file: llm.baseUrl')
    assert(config.llm.model === 'qwen3.5-35b', 'loadConfig file: llm.model')
    assert(config.llm.responseFormat === 'json_object', 'loadConfig file: responseFormat')
    assert(config.maxIterations === 5, 'loadConfig file: maxIterations')
    assert(config.scheduler.enabled === true, 'loadConfig file: defaults still apply')
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

  // --- env override: maxRetries, timeoutMs ---

  {
    const orig = { ...process.env }
    process.env.PRESENCE_MAX_RETRIES = '5'
    process.env.PRESENCE_TIMEOUT_MS = '30000'
    const config = loadConfig('/nonexistent/config.json')
    assert(config.llm.maxRetries === 5, 'env override: PRESENCE_MAX_RETRIES')
    assert(config.llm.timeoutMs === 30000, 'env override: PRESENCE_TIMEOUT_MS')
    delete process.env.PRESENCE_MAX_RETRIES
    delete process.env.PRESENCE_TIMEOUT_MS
    // restore won't affect other tests since they use explicit paths
  }

  {
    process.env.PRESENCE_MAX_RETRIES = 'abc'
    const config = loadConfig('/nonexistent/config.json')
    assert(config.llm.maxRetries === DEFAULTS.llm.maxRetries, 'env override: non-numeric MAX_RETRIES ignored')
    delete process.env.PRESENCE_MAX_RETRIES
  }

  summary()
}

run()
