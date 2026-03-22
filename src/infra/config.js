import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import fp from '../lib/fun-fp.js'

const { Either, Maybe } = fp

// --- 기본값 ---

const DEFAULTS = {
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    apiKey: null,
    responseFormat: 'json_schema',
    maxRetries: 2,
    timeoutMs: 120_000,
  },
  embed: {
    provider: 'openai',
    baseUrl: null,
    apiKey: null,
    model: null,
    dimensions: 256,
  },
  locale: 'ko',
  maxIterations: 10,
  memory: {
    path: null,
  },
  mcp: [],
  heartbeat: {
    enabled: true,
    intervalMs: 300_000,
    prompt: '정기 점검: 현황 확인',
  },
  delegatePolling: {
    intervalMs: 10_000,
  },
  prompt: {
    maxContextTokens: 8000,
    reservedOutputTokens: 1000,
    // 하위 호환: chars 키가 설정되면 자동 변환
    maxContextChars: null,
    reservedOutputChars: null,
  },
}

// --- 순수 병합 (deep, 2단계) ---

const mergeConfig = (base, override) => {
  const result = { ...base }
  for (const [key, val] of Object.entries(override)) {
    if (val != null && typeof val === 'object' && !Array.isArray(val) && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = { ...base[key], ...val }
    } else {
      result[key] = val
    }
  }
  return result
}

// --- 환경변수 오버라이드 (기존 호환) ---

const envOverrides = () => {
  const overrides = {}
  const env = process.env

  if (env.OPENAI_API_KEY || env.OPENAI_MODEL || env.OPENAI_BASE_URL) {
    overrides.llm = {}
    if (env.OPENAI_BASE_URL) overrides.llm.baseUrl = env.OPENAI_BASE_URL
    if (env.OPENAI_MODEL) overrides.llm.model = env.OPENAI_MODEL
    if (env.OPENAI_API_KEY) overrides.llm.apiKey = env.OPENAI_API_KEY
  }

  if (env.PRESENCE_RESPONSE_FORMAT) {
    overrides.llm = overrides.llm || {}
    overrides.llm.responseFormat = env.PRESENCE_RESPONSE_FORMAT
  }

  if (env.PRESENCE_MAX_RETRIES) {
    overrides.llm = overrides.llm || {}
    const n = Number(env.PRESENCE_MAX_RETRIES)
    if (!isNaN(n)) overrides.llm.maxRetries = n
  }

  if (env.PRESENCE_TIMEOUT_MS) {
    overrides.llm = overrides.llm || {}
    const n = Number(env.PRESENCE_TIMEOUT_MS)
    if (!isNaN(n)) overrides.llm.timeoutMs = n
  }

  if (env.PRESENCE_EMBED_PROVIDER || env.PRESENCE_EMBED_BASE_URL || env.PRESENCE_EMBED_API_KEY || env.PRESENCE_EMBED_MODEL || env.PRESENCE_EMBED_DIMENSIONS) {
    overrides.embed = {}
    if (env.PRESENCE_EMBED_PROVIDER) overrides.embed.provider = env.PRESENCE_EMBED_PROVIDER
    if (env.PRESENCE_EMBED_BASE_URL) overrides.embed.baseUrl = env.PRESENCE_EMBED_BASE_URL
    if (env.PRESENCE_EMBED_API_KEY) overrides.embed.apiKey = env.PRESENCE_EMBED_API_KEY
    if (env.PRESENCE_EMBED_MODEL) overrides.embed.model = env.PRESENCE_EMBED_MODEL
    if (env.PRESENCE_EMBED_DIMENSIONS) {
      const d = Number(env.PRESENCE_EMBED_DIMENSIONS)
      if (!isNaN(d)) overrides.embed.dimensions = d
    }
  }

  if (env.PRESENCE_MAX_ITERATIONS) {
    const n = Number(env.PRESENCE_MAX_ITERATIONS)
    if (!isNaN(n)) overrides.maxIterations = n
  }
  if (env.PRESENCE_MEMORY_PATH) overrides.memory = { path: env.PRESENCE_MEMORY_PATH }
  if (env.PRESENCE_HEARTBEAT_MS) {
    const ms = Number(env.PRESENCE_HEARTBEAT_MS)
    if (!isNaN(ms)) overrides.heartbeat = { intervalMs: ms }
  }
  if (env.PRESENCE_HEARTBEAT === 'false') overrides.heartbeat = { ...overrides.heartbeat, enabled: false }

  return overrides
}

// --- 파일 읽기 (Either) ---

const readConfigFile = (filePath, t) =>
  Either.fold(
    _ => ({}),
    content =>
      Either.fold(
        e => {
          const msg = t
            ? t('error.config_parse_error', { path: filePath, message: e.message })
            : `${filePath} JSON parse error: ${e.message}. Using defaults.`
          console.warn(`[config] ${msg}`)
          return {}
        },
        parsed => parsed,
        Either.catch(() => JSON.parse(content)),
      ),
    existsSync(filePath)
      ? Either.Right(readFileSync(filePath, 'utf-8'))
      : Either.Left(null),
  )

// --- 설정 검증 ---

const validateConfig = (config) => {
  const warnings = []
  if (!config.llm.apiKey) warnings.push('llm.apiKey is not set — LLM calls will fail')
  if (!config.llm.baseUrl) warnings.push('llm.baseUrl is not set')
  if (config.embed.dimensions && isNaN(config.embed.dimensions)) warnings.push('embed.dimensions is not a number')
  return warnings
}

// --- 기본 경로 ---

const defaultConfigPath = () => {
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return join(home, '.presence', 'config.json')
}

// --- 설정 로드: defaults → 파일 → 환경변수 ---

const loadConfig = (configPath) => {
  const path = configPath || process.env.PRESENCE_CONFIG || defaultConfigPath()
  const fromFile = readConfigFile(path)
  const fromEnv = envOverrides()

  return mergeConfig(mergeConfig(DEFAULTS, fromFile), fromEnv)
}

export { loadConfig, mergeConfig, envOverrides, readConfigFile, validateConfig, defaultConfigPath, DEFAULTS }
