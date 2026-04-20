import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, join } from 'path'
import { z } from 'zod'
import { t } from '../../i18n/index.js'
import { TOOL_SOURCE } from './tool-registry.js'

const LOCAL_TOOLS = Object.freeze({
  FETCH_TIMEOUT_MS: 15_000,
  TEXT_TRUNCATE_LENGTH: 10_000,
  SHELL_TIMEOUT_MS: 30_000,
})

// --- 도구 인자 스키마 ---

const FileReadArgs   = z.object({ path: z.string().min(1), maxLines: z.number().int().nonnegative().optional(), tailLines: z.number().int().positive().optional() })
const FileWriteArgs  = z.object({ path: z.string().min(1), content: z.string() })
const FileListArgs   = z.object({ path: z.string().min(1) })
const WebFetchArgs   = z.object({ url: z.string().min(1) })
const ShellExecArgs  = z.object({ command: z.string().min(1) })
const CalculateArgs  = z.object({ expression: z.string().min(1) })

// 필수 인자 누락 → i18n 메시지, 타입 오류 → descriptive error
const parseArgs = (schema, args, toolName) => {
  const result = schema.safeParse(args ?? {})
  if (!result.success) {
    const first = result.error.issues[0]
    const arg = first.path.join('.') || 'args'
    const msg = first.code === 'invalid_type' && first.received === undefined
      ? t('error.arg_required', { tool: toolName, arg })
      : `${toolName}: ${arg}: ${first.message}`
    throw new Error(msg)
  }
  return result.data
}

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
// 후보 경로를 순서대로 시도, 첫 번째 유효한 것을 사용.

const normalizePath = (path, allowedDirs) => {
  const resolved = resolve(path)
  const candidates = [
    resolved,
    // 잘못된 절대경로 → 허용 디렉토리 기준 상대 재해석
    ...(allowedDirs.length > 0 && path.startsWith('/')
      ? [resolve(allowedDirs[0], path.replace(/^\/+/, ''))]
      : []),
  ]
  return candidates.find(c => isPathAllowed(c, allowedDirs) && (c === resolved || existsSync(c)))
    || resolved
}

// --- workingDir 기준 경로 해석 (세션별) ---
// 세션의 작업 디렉토리 기준으로 상대경로를 절대경로로 해석.
// allowedDirs 경계를 벗어나면 throw.
// workingDir 누락 시 throw (fallback 없음 — 호출자가 책임).
const resolveInWorkingDir = (relPath, workingDir, allowedDirs) => {
  if (!workingDir) throw new Error('resolveInWorkingDir: workingDir required')
  const absolute = resolve(workingDir, relPath)
  if (!isPathAllowed(absolute, allowedDirs)) {
    throw new Error(t('error.access_denied', { path: relPath, dirs: allowedDirs.join(', ') || '(none)' }))
  }
  return absolute
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
      name: 'file_read', source: TOOL_SOURCE.LOCAL, promptVisible: true,
      description: 'Read a text file. Use relative paths like "package.json" or "src/core/agent.js". Use maxLines to read the first N lines, or tailLines to read the last N lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path (e.g. "package.json")' },
          maxLines: { type: 'integer', description: 'Read only the first N lines' },
          tailLines: { type: 'integer', description: 'Read only the last N lines' },
        },
        required: ['path'],
      },
      handler: (rawArgs) => {
        const { path, maxLines, tailLines } = parseArgs(FileReadArgs, rawArgs, 'file_read')
        const resolved = resolvePath(path)
        checkAccess(resolved)
        if (!existsSync(resolved)) throw new Error(t('error.file_not_found', { path }))
        const content = readFileSync(resolved, 'utf-8')
        const lines = content.split('\n')
        if (tailLines != null) return lines.slice(-tailLines).join('\n')
        if (maxLines) return lines.slice(0, maxLines).join('\n')
        return content
      },
    },

    {
      name: 'file_write', source: TOOL_SOURCE.LOCAL, promptVisible: true,
      description: 'Write content to a file. Use relative paths. REQUIRES APPROVE before use.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path (e.g. "output.txt")' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
      handler: (rawArgs) => {
        const { path, content } = parseArgs(FileWriteArgs, rawArgs, 'file_write')
        const resolved = resolvePath(path)
        checkAccess(resolved)
        writeFileSync(resolved, content, 'utf-8')
        return `Written ${content.length} chars to ${resolved}`
      },
    },

    {
      name: 'file_list', source: TOOL_SOURCE.LOCAL, promptVisible: true,
      description: 'List files and directories. Use relative paths like "src/core" or ".".',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path (e.g. "src")' },
        },
        required: ['path'],
      },
      handler: (rawArgs) => {
        const { path: dirPath } = parseArgs(FileListArgs, rawArgs, 'file_list')
        const resolved = resolvePath(dirPath)
        checkAccess(resolved)
        if (!existsSync(resolved)) throw new Error(t('error.dir_not_found', { path: dirPath }))
        const items = readdirSync(resolved).map(name => {
          try {
            const stat = statSync(join(resolved, name))
            return { name, isDir: stat.isDirectory() }
          } catch (_) {
            return { name, isDir: false }
          }
        })
        // 디렉토리 먼저, 파일 후에 (각각 알파벳 순)
        items.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)
        const lines = items.map((it, i) => {
          const isLast = i === items.length - 1
          const connector = isLast ? '└── ' : '├── '
          return `${connector}${it.name}${it.isDir ? '/' : ''}`
        })
        return lines.join('\n')
      },
    },

    {
      name: 'web_fetch', source: TOOL_SOURCE.LOCAL, promptVisible: true,
      description: 'Fetch content from a specific URL. NOT a search engine — only use with URLs from conversation context or step results. Do not fabricate URLs.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
      handler: async (rawArgs) => {
        const { url } = parseArgs(WebFetchArgs, rawArgs, 'web_fetch')
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), LOCAL_TOOLS.FETCH_TIMEOUT_MS)
        try {
          const res = await fetch(url, { signal: controller.signal })
          if (!res.ok) throw new Error(t('error.http_error', { status: res.status }))
          const text = await res.text()
          return text.length > LOCAL_TOOLS.TEXT_TRUNCATE_LENGTH ? text.slice(0, LOCAL_TOOLS.TEXT_TRUNCATE_LENGTH) + '\n...(truncated)' : text
        } finally {
          clearTimeout(timeout)
        }
      },
    },

    {
      name: 'shell_exec', source: TOOL_SOURCE.LOCAL, promptVisible: true,
      description: 'Execute a shell command. REQUIRES APPROVE before use. Returns stdout.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
        },
        required: ['command'],
      },
      handler: (rawArgs) => {
        const { command } = parseArgs(ShellExecArgs, rawArgs, 'shell_exec')
        try {
          return execSync(command, { encoding: 'utf-8', timeout: LOCAL_TOOLS.SHELL_TIMEOUT_MS }).trim()
        } catch (e) {
          throw new Error(t('error.command_failed', { message: e.message }))
        }
      },
    },

    {
      name: 'calculate', source: TOOL_SOURCE.LOCAL, promptVisible: true,
      description: 'Evaluate a math expression. Returns the result as string.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Math expression (e.g. "7 * 13", "(100 + 200) * 3")' },
        },
        required: ['expression'],
      },
      handler: (rawArgs) => {
        const { expression } = parseArgs(CalculateArgs, rawArgs, 'calculate')
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

/**
 * `createLocalTools` — Creates built-in local tools: file_read, file_write, file_list, web_fetch, shell_exec, calculate.
 * @see createLocalTools
 *
 * `isPathAllowed(path, allowedDirs)` — Returns true if the resolved path is within one of the allowed directories.
 *
 * `normalizePath(path, allowedDirs)` — Resolves and normalises a path, falling back to allowed-dir-relative resolution.
 */
export { createLocalTools, isPathAllowed, normalizePath, resolveInWorkingDir }
