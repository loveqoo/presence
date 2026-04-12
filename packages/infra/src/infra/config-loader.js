import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import fp from '@presence/core/lib/fun-fp.js'
import { Config } from './config.js'

const { Either, Maybe, Reader } = fp

// =============================================================================
// Config 파일 로딩 + Reader 기반 로더 + 브릿지
// =============================================================================

// --- 파일 읽기 → Maybe<Config> ---

const fromFile = (filePath, t) =>
  Either.fold(
    _ => Maybe.Nothing(),
    content =>
      Either.fold(
        err => {
          const msg = t
            ? t('error.config_parse_error', { path: filePath, message: err.message })
            : `${filePath} JSON parse error: ${err.message}. Using defaults.`
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

// --- Maybe<Config> 배열 → Monoid fold → validate ---

const loadAndMerge = (maybeLayers) => {
  const merged = maybeLayers
    .reduce((acc, layer) => Config.Monoid.concat(acc, layer), Maybe.Just(Config.DEFAULTS))

  const config = Maybe.fold(() => Config.DEFAULTS, x => x, merged)
  const result = Config.Schema.safeParse(config)
  if (!result.success) {
    result.error.errors.forEach(err =>
      console.warn(`[config] schema error — ${err.path.join('.')}: ${err.message}`)
    )
    return config
  }
  return result.data
}

// --- Reader 기반 로더 ---

// DEFAULTS → server.json
const loadServerR = Reader.asks(({ basePath }) => {
  const dir = Config.resolveDir(basePath)
  return loadAndMerge([fromFile(join(dir, 'server.json'))])
})

// users/{username}/config.json 원본 (머지 없음)
const loadUserR = Reader.asks(({ basePath, username }) => {
  if (!username) throw new Error('username is required for loadUser')
  const dir = Config.resolveDir(basePath)
  return fromFile(join(dir, 'users', username, 'config.json'))
})

// DEFAULTS → server.json → users/{username}/config.json
const loadUserMergedR = Reader.asks(({ basePath, username }) => {
  if (!username) throw new Error('username is required for loadUserMerged')
  const dir = Config.resolveDir(basePath)
  return loadAndMerge([
    fromFile(join(dir, 'server.json')),
    fromFile(join(dir, 'users', username, 'config.json')),
  ])
})

// resolved server config 위에 유저 config를 병합.
const mergeUserOverR = Reader.asks(({ serverConfig, username, basePath }) => {
  if (!username) throw new Error('username is required for mergeUserOver')
  const dir = Config.resolveDir(basePath)
  const base = serverConfig instanceof Config ? serverConfig : new Config(serverConfig)
  const userLayer = fromFile(join(dir, 'users', username, 'config.json'))
  return loadAndMerge([Maybe.Just(base), userLayer])
})

// --- 브릿지 ---

const loadServer = (opts = {}) => loadServerR.run({ basePath: opts.basePath })
const loadUserMerged = (username, opts = {}) => loadUserMergedR.run({ basePath: opts.basePath, username })
const mergeUserOver = (serverConfig, username, opts = {}) => mergeUserOverR.run({ serverConfig, username, basePath: opts.basePath })

export {
  fromFile, loadAndMerge,
  loadServerR, loadUserR, loadUserMergedR, mergeUserOverR,
  loadServer, loadUserMerged, mergeUserOver,
}
