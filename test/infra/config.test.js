import { loadConfig, mergeConfig, readConfigFile, DEFAULTS } from '../../src/infra/config.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

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
    assert(result.strategy === 'plan', 'mergeConfig: default strategy')
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
    assert(config.strategy === 'plan', 'loadConfig no file: default strategy')
    assert(config.heartbeat.enabled === true, 'loadConfig no file: heartbeat enabled')
  }

  {
    const dir = join(tmpdir(), `presence-config-load-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({
      llm: { baseUrl: 'http://localhost:8045/v1', model: 'qwen3.5-35b', responseFormat: 'json_object' },
      strategy: 'react',
    }))

    const config = loadConfig(path)
    assert(config.llm.baseUrl === 'http://localhost:8045/v1', 'loadConfig file: llm.baseUrl')
    assert(config.llm.model === 'qwen3.5-35b', 'loadConfig file: llm.model')
    assert(config.llm.responseFormat === 'json_object', 'loadConfig file: responseFormat')
    assert(config.strategy === 'react', 'loadConfig file: strategy')
    assert(config.heartbeat.enabled === true, 'loadConfig file: defaults still apply')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- DEFAULTS shape ---

  {
    assert(DEFAULTS.llm.responseFormat === 'json_schema', 'DEFAULTS: responseFormat is json_schema')
    assert(DEFAULTS.embed.dimensions === 256, 'DEFAULTS: embed dimensions')
    assert(Array.isArray(DEFAULTS.mcp), 'DEFAULTS: mcp is array')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
