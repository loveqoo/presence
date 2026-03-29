import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import fp from '@presence/core/lib/fun-fp.js'

const { Either, Maybe } = fp

// --- Config 스키마 ---

const ConfigSchema = z.object({
  llm: z.object({
    baseUrl: z.string(),
    model: z.string(),
    apiKey: z.string().nullable(),
    responseFormat: z.enum(['json_schema', 'json_object']),
    maxRetries: z.number().int().min(0),
    timeoutMs: z.number().positive(),
  }),
  embed: z.object({
    provider: z.string(),
    baseUrl: z.string().nullable(),
    apiKey: z.string().nullable(),
    model: z.string().nullable(),
    dimensions: z.number().int().positive(),
  }),
  locale: z.string(),
  maxIterations: z.number().int().positive(),
  memory: z.object({ path: z.string().nullable() }),
  mcp: z.array(z.unknown()),
  scheduler: z.object({
    enabled: z.boolean(),
    pollIntervalMs: z.number().positive(),
    todoReview: z.object({
      enabled: z.boolean(),
      cron: z.string(),
    }),
  }),
  delegatePolling: z.object({ intervalMs: z.number().positive() }),
  agents: z.array(z.object({
    name: z.string(),
    description: z.string(),
    capabilities: z.array(z.string()).default([]),
  })).default([]),
  prompt: z.object({
    maxContextTokens: z.number().int().positive(),
    reservedOutputTokens: z.number().int().positive(),
    maxContextChars: z.number().nullable(),
    reservedOutputChars: z.number().nullable(),
  }),
})

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
  scheduler: {
    enabled: true,
    pollIntervalMs: 60_000,
    todoReview: {
      enabled: true,
      cron: '0 9 * * *',  // 매일 09:00
    },
  },
  delegatePolling: {
    intervalMs: 10_000,
  },
  agents: [],
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
  if (env.PRESENCE_SCHEDULER_POLL_MS) {
    const ms = Number(env.PRESENCE_SCHEDULER_POLL_MS)
    if (!isNaN(ms)) overrides.scheduler = { pollIntervalMs: ms }
  }
  if (env.PRESENCE_SCHEDULER === 'false') overrides.scheduler = { ...overrides.scheduler, enabled: false }

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

// --- 설정 검증 (런타임 경고: 구조 오류는 ConfigSchema.safeParse가 담당) ---

const validateConfig = (config) => {
  const warnings = []
  if (!config.llm?.apiKey) warnings.push('llm.apiKey is not set — LLM calls will fail')
  return warnings
}

// --- 기본 경로 ---

const defaultPresenceDir = () => {
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return join(home, '.presence')
}

// --- 인스턴스 스키마 ---

const InstanceDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  port: z.number().int().min(1024).max(65535),
  host: z.string().default('127.0.0.1'),
  enabled: z.boolean().default(true),
  autoStart: z.boolean().default(true),
})

const InstancesFileSchema = z.object({
  orchestrator: z.object({
    port: z.number().int().min(0).default(3000),
    host: z.string().default('127.0.0.1'),
  }),
  instances: z.array(InstanceDefSchema).min(1),
})

const ClientConfigSchema = z.object({
  instanceId: z.string(),
  server: z.object({
    url: z.string().url(),
  }),
  ui: z.object({
    locale: z.string().default('ko'),
  }).default({ locale: 'ko' }),
})

// --- instances.json 로드 (Either) ---
// Either.Right(data) | Either.Left(errorMessage)

const validateWithSchema = (schema, raw, label) => {
  const result = schema.safeParse(raw)
  return result.success
    ? Either.Right(result.data)
    : Either.Left(`${label} validation failed: ${(result.error.issues || []).map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`)
}

const loadInstancesFile = (presenceDir) => {
  const dir = presenceDir || process.env.PRESENCE_DIR || defaultPresenceDir()
  const filePath = join(dir, 'instances.json')
  const raw = readConfigFile(filePath)
  if (Object.keys(raw).length === 0) return Either.Left(`instances.json not found or empty: ${filePath}`)
  return validateWithSchema(InstancesFileSchema, raw, 'instances.json')
}

// --- 인스턴스별 설정 로드: DEFAULTS → server.json → instances/{id}.json → env ---

const loadInstanceConfig = (instanceId, { basePath } = {}) => {
  if (!instanceId) throw new Error('instanceId is required for loadInstanceConfig')
  const dir = basePath || process.env.PRESENCE_DIR || defaultPresenceDir()
  const serverFile = join(dir, 'server.json')
  const instanceFile = join(dir, 'instances', `${instanceId}.json`)

  const fromServer = readConfigFile(serverFile)
  const fromInstance = readConfigFile(instanceFile)
  const fromEnv = envOverrides()

  const merged = mergeConfig(
    mergeConfig(mergeConfig(DEFAULTS, fromServer), fromInstance),
    fromEnv,
  )

  const result = ConfigSchema.safeParse(merged)
  if (!result.success) {
    result.error.errors.forEach(e =>
      console.warn(`[config] schema error — ${e.path.join('.')}: ${e.message}`)
    )
    return merged
  }
  return result.data
}

// --- 클라이언트 설정 로드 (Either) ---
// Either.Right(data) | Either.Left(errorMessage)

const loadClientConfig = (userId, { basePath } = {}) => {
  const dir = basePath || process.env.PRESENCE_DIR || defaultPresenceDir()
  const filePath = join(dir, 'clients', `${userId}.json`)
  const raw = readConfigFile(filePath)
  if (Object.keys(raw).length === 0) return Either.Left(`Client config not found: ${filePath}`)
  return validateWithSchema(ClientConfigSchema, raw, 'Client config')
}

export {
  loadInstanceConfig, loadInstancesFile, loadClientConfig,
  mergeConfig, envOverrides, readConfigFile, validateConfig,
  defaultPresenceDir, DEFAULTS, ConfigSchema,
  InstancesFileSchema, InstanceDefSchema, ClientConfigSchema,
}
