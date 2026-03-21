import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, join } from 'path'
import { t } from '../i18n/index.js'

// --- 경로 검증 (순수) ---

const isPathAllowed = (path, allowedDirs) => {
  if (allowedDirs.length === 0) return true
  const resolved = resolve(path)
  return allowedDirs.some(dir => {
    const resolvedDir = resolve(dir)
    return resolved === resolvedDir || resolved.startsWith(resolvedDir + '/')
  })
}

// --- 경로 정규화 ---

const normalizePath = (path, allowedDirs) => {
  const resolved = resolve(path)
  if (isPathAllowed(resolved, allowedDirs)) return resolved
  if (allowedDirs.length > 0 && path.startsWith('/')) {
    const stripped = path.replace(/^\/+/, '')
    const candidate = resolve(allowedDirs[0], stripped)
    if (isPathAllowed(candidate, allowedDirs) && existsSync(candidate)) return candidate
  }
  return resolved
}

// --- 도구 정의 ---

const createLocalTools = ({ allowedDirs = [] } = {}) => {
  const resolvePath = (path) => normalizePath(path, allowedDirs)

  const checkAccess = (path) => {
    if (!isPathAllowed(path, allowedDirs)) {
      const dirs = allowedDirs.length > 0 ? allowedDirs.join(', ') : '(none)'
      throw new Error(t('error.access_denied', { path, dirs }))
    }
  }

  return [
    {
      name: 'file_read',
      description: 'Read a text file. Use relative paths like "package.json" or "src/core/agent.js".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path (e.g. "package.json")' },
        },
        required: ['path'],
      },
      handler: ({ path } = {}) => {
        if (!path) throw new Error(t('error.arg_required', { tool: 'file_read', arg: 'path' }))
        const resolved = resolvePath(path)
        checkAccess(resolved)
        if (!existsSync(resolved)) throw new Error(t('error.file_not_found', { path }))
        return readFileSync(resolved, 'utf-8')
      },
    },

    {
      name: 'file_write',
      description: 'Write content to a file. Use relative paths. REQUIRES APPROVE before use.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path (e.g. "output.txt")' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
      handler: ({ path, content } = {}) => {
        if (!path || !content) throw new Error(t('error.arg_required', { tool: 'file_write', arg: 'path, content' }))
        const resolved = resolvePath(path)
        checkAccess(resolved)
        writeFileSync(resolved, content, 'utf-8')
        return `Written ${content.length} chars to ${resolved}`
      },
    },

    {
      name: 'file_list',
      description: 'List files and directories. Use relative paths like "src/core" or ".".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path (e.g. "src")' },
        },
        required: ['path'],
      },
      handler: ({ path: dirPath } = {}) => {
        if (!dirPath) throw new Error(t('error.arg_required', { tool: 'file_list', arg: 'path' }))
        const resolved = resolvePath(dirPath)
        checkAccess(resolved)
        if (!existsSync(resolved)) throw new Error(t('error.dir_not_found', { path: dirPath }))
        const entries = readdirSync(resolved).map(name => {
          try {
            const stat = statSync(join(resolved, name))
            return `${stat.isDirectory() ? '[dir]' : '[file]'} ${name}`
          } catch (_) {
            return `[?] ${name}`
          }
        })
        return entries.join('\n')
      },
    },

    {
      name: 'web_fetch',
      description: 'Fetch content from a URL. Returns text content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
      handler: async ({ url } = {}) => {
        if (!url) throw new Error(t('error.arg_required', { tool: 'web_fetch', arg: 'url' }))
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 15_000)
        try {
          const res = await fetch(url, { signal: controller.signal })
          if (!res.ok) throw new Error(t('error.http_error', { status: res.status }))
          const text = await res.text()
          return text.length > 10_000 ? text.slice(0, 10_000) + '\n...(truncated)' : text
        } finally {
          clearTimeout(timeout)
        }
      },
    },

    {
      name: 'shell_exec',
      description: 'Execute a shell command. REQUIRES APPROVE before use. Returns stdout.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
      handler: ({ command } = {}) => {
        if (!command) throw new Error(t('error.arg_required', { tool: 'shell_exec', arg: 'command' }))
        try {
          return execSync(command, { encoding: 'utf-8', timeout: 30_000 }).trim()
        } catch (e) {
          throw new Error(t('error.command_failed', { message: e.message }))
        }
      },
    },

    {
      name: 'calculate',
      description: 'Evaluate a math expression. Returns the result as string.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Math expression (e.g. "7 * 13", "(100 + 200) * 3")' },
        },
        required: ['expression'],
      },
      handler: ({ expression } = {}) => {
        if (!expression) throw new Error(t('error.arg_required', { tool: 'calculate', arg: 'expression' }))
        try {
          const result = new Function(`return (${expression})`)()
          if (typeof result !== 'number' || !isFinite(result)) throw new Error('Invalid result')
          return String(result)
        } catch (e) {
          throw new Error(t('error.command_failed', { message: `Invalid expression: ${expression}` }))
        }
      },
    },
  ]
}

export { createLocalTools, isPathAllowed, normalizePath }
