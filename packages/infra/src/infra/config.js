import { join } from 'path'
import { z } from 'zod'
import fp from '@presence/core/lib/fun-fp.js'

const { Maybe, Semigroup } = fp

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
      description: z.string().default(''),
      capabilities: z.array(z.string()).default([]),
      // docs/design/agent-identity-model.md §6.1 — persona 는 agent 의 필드.
      // M2/M3 에서 단계적으로 채워짐. v1 optional.
      persona: z.object({
        name: z.string().optional(),
        systemPrompt: z.string().nullable().optional(),
        rules: z.array(z.string()).default([]),
        tools: z.array(z.string()).default([]),
      }).optional(),
      workingDir: z.string().optional(),
      createdAt: z.string().optional(),
      createdBy: z.string().optional(),
      archived: z.boolean().default(false),
      archivedAt: z.string().nullable().optional(),
    })).default([]),
    prompt: z.object({
      maxContextTokens: z.number().int().positive(),
      reservedOutputTokens: z.number().int().positive(),
      maxContextChars: z.number().nullable(),
      reservedOutputChars: z.number().nullable(),
    }),
    // docs/design/agent-identity-model.md §11.1 — A2A 활성화 플래그.
    // enabled=false (기본): /a2a 라우트 미등록 / self card 미생성 / publicUrl 불요.
    // enabled=true:  publicUrl 필수. self card URL = publicUrl + '/a2a/' + agentId.
    // recoverOnStart: A2A 큐 재시작 회복 (S4). false 면 recoverA2aQueue skip — 운영 rollback.
    a2a: z.object({
      enabled: z.boolean().default(false),
      publicUrl: z.string().nullable().default(null),
      recoverOnStart: z.boolean().default(true),
    }).default({ enabled: false, publicUrl: null, recoverOnStart: true }),
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
    a2a: { enabled: false, publicUrl: null, recoverOnStart: true },
  })

  constructor(data) { Object.assign(this, data) }

  // --- 합성 ---

  static merge(base, override) { return Config.SG.concat(base, override) }

  // --- 경로 ---

  static defaultPresenceDir() {
    const home = process.env.HOME || process.env.USERPROFILE || '.'
    return join(home, '.presence')
  }

  static presenceDir() {
    if (process.env.PRESENCE_DIR) return process.env.PRESENCE_DIR
    return Config.defaultPresenceDir()
  }

  static userDataPath(username) {
    if (!username) throw new Error('username is required for userDataPath')
    return join(Config.presenceDir(), 'users', username)
  }

  static resolveDir(basePath) {
    return basePath || process.env.PRESENCE_DIR || Config.presenceDir()
  }

}

export { Config }
