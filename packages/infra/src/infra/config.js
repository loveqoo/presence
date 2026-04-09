import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import fp from '@presence/core/lib/fun-fp.js'

const { Either, Maybe, Semigroup, Reader } = fp

class Config {
  // --- 스키마 ---

  static Schema = z.object({
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
      dimensions: z.number().int().positive().nullable(),
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

  // --- Semigroup: 2단계 deep merge ---

  static SG = new Semigroup((base, override) => {
    const result = { ...base }
    for (const [key, val] of Object.entries(override)) {
      if (val != null && typeof val === 'object' && !Array.isArray(val) && typeof base[key] === 'object' && !Array.isArray(base[key])) {
        result[key] = { ...base[key], ...val }
      } else {
        result[key] = val
      }
    }
    return new Config(result)
  }, 'Config', Semigroup.types, 'config')

  static Monoid = Maybe.Monoid(Config.SG)

  // --- 기본값 ---

  static DEFAULTS = new Config({
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
    memory: { path: null },
    mcp: [],
    scheduler: {
      enabled: true,
      pollIntervalMs: 60_000,
      todoReview: {
        enabled: true,
        cron: '0 9 * * *',
      },
    },
    delegatePolling: { intervalMs: 10_000 },
    agents: [],
    prompt: {
      maxContextTokens: 8000,
      reservedOutputTokens: 1000,
      maxContextChars: null,
      reservedOutputChars: null,
    },
  })

  constructor(data) { Object.assign(this, data) }

  // --- 합성 ---

  static merge(base, override) { return Config.SG.concat(base, override) }

  // --- 파일 읽기 → Maybe<Config> ---

  static fromFile(filePath, t) {
    return Either.fold(
      _ => Maybe.Nothing(),
      content =>
        Either.fold(
          e => {
            const msg = t
              ? t('error.config_parse_error', { path: filePath, message: e.message })
              : `${filePath} JSON parse error: ${e.message}. Using defaults.`
            console.warn(`[config] ${msg}`)
            return Maybe.Nothing()
          },
          parsed => Maybe.Just(new Config(parsed)),
          Either.catch(() => JSON.parse(content)),
        ),
      existsSync(filePath)
        ? Either.Right(readFileSync(filePath, 'utf-8'))
        : Either.Left(null),
    )
  }

  // --- 검증 ---

  static validate(config) {
    const warnings = []
    if (!config.llm?.apiKey) warnings.push('llm.apiKey is not set — LLM calls will fail')
    return warnings
  }

  // --- 경로 ---

  static presenceDir() {
    const home = process.env.HOME || process.env.USERPROFILE || '.'
    return join(home, '.presence')
  }

  static userDataPath(username) {
    if (!username) throw new Error('username is required for userDataPath')
    return join(Config.presenceDir(), 'users', username)
  }

  static resolveDir(basePath) {
    return basePath || process.env.PRESENCE_DIR || Config.presenceDir()
  }

  // --- Maybe<Config> 배열 → Monoid fold → validate ---

  static loadAndMerge(maybeLayers) {
    const merged = maybeLayers
      .reduce((acc, layer) => Config.Monoid.concat(acc, layer), Maybe.Just(Config.DEFAULTS))

    const config = Maybe.fold(() => Config.DEFAULTS, x => x, merged)
    const result = Config.Schema.safeParse(config)
    if (!result.success) {
      result.error.errors.forEach(e =>
        console.warn(`[config] schema error — ${e.path.join('.')}: ${e.message}`)
      )
      return config
    }
    return result.data
  }

  // --- Reader 기반 설정 로드 ---

  // DEFAULTS → server.json
  static loadServerR = Reader.asks(({ basePath }) => {
    const dir = Config.resolveDir(basePath)
    return Config.loadAndMerge([Config.fromFile(join(dir, 'server.json'))])
  })

  // users/{username}/config.json 원본 (머지 없음)
  static loadUserR = Reader.asks(({ basePath, username }) => {
    if (!username) throw new Error('username is required for loadUser')
    const dir = Config.resolveDir(basePath)
    return Config.fromFile(join(dir, 'users', username, 'config.json'))
  })

  // DEFAULTS → server.json → users/{username}/config.json
  static loadUserMergedR = Reader.asks(({ basePath, username }) => {
    if (!username) throw new Error('username is required for loadUserMerged')
    const dir = Config.resolveDir(basePath)
    return Config.loadAndMerge([
      Config.fromFile(join(dir, 'server.json')),
      Config.fromFile(join(dir, 'users', username, 'config.json')),
    ])
  })

  // --- 브릿지 ---

  static loadServer(opts = {}) { return Config.loadServerR.run({ basePath: opts.basePath }) }
  static loadUser(username, opts = {}) { return Config.loadUserR.run({ basePath: opts.basePath, username }) }
  static loadUserMerged(username, opts = {}) { return Config.loadUserMergedR.run({ basePath: opts.basePath, username }) }
}

export { Config }
