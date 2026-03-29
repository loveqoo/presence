import {
  loadInstanceConfig, loadInstancesFile, loadClientConfig,
  mergeConfig, readConfigFile, DEFAULTS,
} from '@presence/infra/infra/config.js'
import fp from '@presence/core/lib/fun-fp.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, summary } from '../lib/assert.js'

const { Either } = fp
const isLeft = (e) => Either.fold(() => true, () => false, e)
const isRight = (e) => Either.fold(() => false, () => true, e)
const getRight = (e) => Either.fold(() => null, v => v, e)
const getLeft = (e) => Either.fold(v => v, () => null, e)

function createTmpDir(suffix) {
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
    const dir = createTmpDir('read-valid')
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ llm: { model: 'local-model' } }))

    const result = readConfigFile(path)
    assert(result.llm.model === 'local-model', 'readConfigFile valid: parsed correctly')
    rmSync(dir, { recursive: true, force: true })
  }

  {
    const dir = createTmpDir('read-bad')
    const path = join(dir, 'config.json')
    writeFileSync(path, '<<<not json>>>')

    const result = readConfigFile(path)
    assert(Object.keys(result).length === 0, 'readConfigFile invalid JSON: returns empty')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- loadInstanceConfig: instanceId 필수 ---

  {
    let threw = false
    try { loadInstanceConfig() } catch { threw = true }
    assert(threw, 'loadInstanceConfig: throws without instanceId')
  }

  // --- loadInstanceConfig: DEFAULTS만 (server.json/instance.json 없음) ---

  {
    const dir = createTmpDir('instance-defaults')
    mkdirSync(join(dir, 'instances'), { recursive: true })
    const config = loadInstanceConfig('test', { basePath: dir })
    assert(config.llm.model === DEFAULTS.llm.model, 'loadInstanceConfig no files: uses defaults')
    assert(config.maxIterations === 10, 'loadInstanceConfig no files: default maxIterations')
    assert(config.scheduler.enabled === true, 'loadInstanceConfig no files: scheduler enabled')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- loadInstanceConfig: server.json → instance override 머지 체인 ---

  {
    const dir = createTmpDir('instance-merge')
    writeJson(dir, 'server.json', {
      llm: { baseUrl: 'http://localhost:8045/v1', model: 'base-model' },
      maxIterations: 5,
    })
    writeJson(dir, 'instances/anthony.json', {
      llm: { model: 'override-model', apiKey: 'sk-test' },
      locale: 'en',
    })

    const config = loadInstanceConfig('anthony', { basePath: dir })
    // server.json의 baseUrl 유지
    assert(config.llm.baseUrl === 'http://localhost:8045/v1', 'merge chain: server.json baseUrl preserved')
    // instance override가 model 덮어씀
    assert(config.llm.model === 'override-model', 'merge chain: instance overrides model')
    // instance override가 apiKey 추가
    assert(config.llm.apiKey === 'sk-test', 'merge chain: instance adds apiKey')
    // server.json의 maxIterations 유지 (instance에서 미설정)
    assert(config.maxIterations === 5, 'merge chain: server.json maxIterations preserved')
    // instance의 locale override
    assert(config.locale === 'en', 'merge chain: instance overrides locale')
    // DEFAULTS의 scheduler 유지
    assert(config.scheduler.enabled === true, 'merge chain: defaults still apply')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- loadInstanceConfig: env override가 최종 우선 ---

  {
    const dir = createTmpDir('instance-env')
    writeJson(dir, 'server.json', { llm: { model: 'server-model' } })
    writeJson(dir, 'instances/test.json', { llm: { model: 'instance-model' } })

    const origModel = process.env.OPENAI_MODEL
    process.env.OPENAI_MODEL = 'env-model'
    const config = loadInstanceConfig('test', { basePath: dir })
    assert(config.llm.model === 'env-model', 'merge chain: env overrides everything')
    if (origModel) process.env.OPENAI_MODEL = origModel
    else delete process.env.OPENAI_MODEL
    rmSync(dir, { recursive: true, force: true })
  }

  // --- loadInstancesFile ---

  {
    const result = loadInstancesFile('/nonexistent')
    assert(isLeft(result), 'loadInstancesFile: Left when file missing')
    assert(getLeft(result).includes('not found'), 'loadInstancesFile: error message mentions not found')
  }

  {
    const dir = createTmpDir('instances-file')
    writeJson(dir, 'instances.json', {
      orchestrator: { port: 3000, host: '127.0.0.1' },
      instances: [
        { id: 'anthony', port: 3001 },
        { id: 'team-be', port: 3002, enabled: false },
      ],
    })

    const either = loadInstancesFile(dir)
    assert(isRight(either), 'instancesFile: Right on valid file')
    const result = getRight(either)
    assert(result.orchestrator.port === 3000, 'instancesFile: orchestrator port')
    assert(result.instances.length === 2, 'instancesFile: 2 instances')
    assert(result.instances[0].id === 'anthony', 'instancesFile: first id')
    assert(result.instances[0].host === '127.0.0.1', 'instancesFile: default host')
    assert(result.instances[0].enabled === true, 'instancesFile: default enabled')
    assert(result.instances[0].autoStart === true, 'instancesFile: default autoStart')
    assert(result.instances[1].enabled === false, 'instancesFile: explicit enabled=false')
    rmSync(dir, { recursive: true, force: true })
  }

  {
    const dir = createTmpDir('instances-invalid')
    writeJson(dir, 'instances.json', { instances: [] }) // min(1) 위반

    const result = loadInstancesFile(dir)
    assert(isLeft(result), 'instancesFile: Left on validation failure (empty instances)')
    rmSync(dir, { recursive: true, force: true })
  }

  // --- loadClientConfig ---

  {
    const result = loadClientConfig('nonexistent', { basePath: '/nonexistent' })
    assert(isLeft(result), 'loadClientConfig: Left when file missing')
  }

  {
    const dir = createTmpDir('client-config')
    writeJson(dir, 'clients/anthony.json', {
      instanceId: 'anthony',
      server: { url: 'http://192.168.1.10:3001' },
    })

    const either = loadClientConfig('anthony', { basePath: dir })
    assert(isRight(either), 'clientConfig: Right on valid file')
    const result = getRight(either)
    assert(result.instanceId === 'anthony', 'clientConfig: instanceId')
    assert(result.server.url === 'http://192.168.1.10:3001', 'clientConfig: server url')
    assert(result.ui.locale === 'ko', 'clientConfig: default locale')
    rmSync(dir, { recursive: true, force: true })
  }

  {
    const dir = createTmpDir('client-invalid')
    writeJson(dir, 'clients/bad.json', { server: { url: 'not-a-url' } })

    const result = loadClientConfig('bad', { basePath: dir })
    assert(isLeft(result), 'clientConfig: Left on validation failure')
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
    process.env.PRESENCE_MAX_RETRIES = '5'
    process.env.PRESENCE_TIMEOUT_MS = '30000'
    const dir = createTmpDir('env-override')
    mkdirSync(join(dir, 'instances'), { recursive: true })
    const config = loadInstanceConfig('test', { basePath: dir })
    assert(config.llm.maxRetries === 5, 'env override: PRESENCE_MAX_RETRIES')
    assert(config.llm.timeoutMs === 30000, 'env override: PRESENCE_TIMEOUT_MS')
    delete process.env.PRESENCE_MAX_RETRIES
    delete process.env.PRESENCE_TIMEOUT_MS
    rmSync(dir, { recursive: true, force: true })
  }

  {
    process.env.PRESENCE_MAX_RETRIES = 'abc'
    const dir = createTmpDir('env-invalid')
    mkdirSync(join(dir, 'instances'), { recursive: true })
    const config = loadInstanceConfig('test', { basePath: dir })
    assert(config.llm.maxRetries === DEFAULTS.llm.maxRetries, 'env override: non-numeric MAX_RETRIES ignored')
    delete process.env.PRESENCE_MAX_RETRIES
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run()
