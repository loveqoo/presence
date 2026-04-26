import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, join } from 'path'
import { z } from 'zod'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { t } from '../../i18n/index.js'
import { TOOL_SOURCE } from './tool-registry.js'

const LOCAL_TOOLS = Object.freeze({
  FETCH_TIMEOUT_MS: 15_000,
  TEXT_TRUNCATE_LENGTH: 10_000,
  SHELL_TIMEOUT_MS: 30_000,
  WEB_FETCH_MIN_CONTENT: 200,   // 이보다 짧으면 의심
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
// docs/specs/agent-identity.md — workingDir (= 유저 workspace) 경계 lexical prefix 매칭.
// Symlink realpath 해석은 하지 않음 (의도적). 유저가 workspace 안에 symlink 를 만들어
// 외부 접근하는 것은 OS-level 권한 영역이며, 별도 보안 강화는 follow-up.
const isWithinWorkspace = (path, workingDir) => {
  if (!workingDir) return false
  const resolved = resolve(path)
  const base = resolve(workingDir)
  return resolved === base || resolved.startsWith(base + '/')
}

// --- 경로 정규화 ---
// 상대경로 → workingDir 기준 절대경로. 경계 밖이면 workingDir 로 fallback.
const normalizePath = (path, workingDir) => {
  if (!workingDir) return resolve(path)
  const resolved = resolve(workingDir, path)
  return isWithinWorkspace(resolved, workingDir) ? resolved : workingDir
}

// --- HTML → 텍스트 변환 (FP-62) ---
// Mozilla Readability + jsdom. Firefox Reader View 알고리즘이 본문을 지능적으로
// 식별하여 nav/광고/boilerplate 를 자동 제거. Readability 가 article-like 페이지가
// 아니라고 판단하면 (예: 홈페이지, 검색 결과) body 의 plain text 로 fallback.
const htmlToText = (html, url) => {
  if (typeof html !== 'string' || html.length === 0) return ''
  try {
    const dom = new JSDOM(html, { url: url || 'https://example.com' })
    const doc = dom.window.document
    const reader = new Readability(doc)
    const article = reader.parse()
    if (article && typeof article.textContent === 'string') {
      const extracted = article.textContent.replace(/\s+/g, ' ').trim()
      if (extracted.length > 0) return extracted
    }
    // Fallback: Readability 가 article 판별 실패 — body textContent 추출.
    const body = doc.body?.textContent?.replace(/\s+/g, ' ').trim()
    return body || ''
  } catch (_) {
    return ''
  }
}

// Content-Type 이 HTML 계열이면 htmlToText 로 변환.
const looksLikeHtml = (contentType, body) => {
  if (/html/i.test(contentType || '')) return true
  // Content-Type 누락 케이스 — body 첫 문자 검사
  const head = (body || '').slice(0, 200).toLowerCase()
  return head.includes('<!doctype html') || /<html[\s>]/.test(head)
}

// --- web_fetch 결과 품질 점검 (FP-62) ---
// 사후 품질 점검 — 빈/짧은 본문 감지 시 경고 prefix 부착 대상으로 분류.
// 입력은 htmlToText 를 거친 본문 텍스트. 도메인 특화 패턴 없이 범용 신호만 사용.
const analyzeWebFetchResult = (text) => {
  const trimmed = (text || '').trim()
  if (trimmed.length === 0) return { suspicious: true, reason: 'empty_response' }
  if (trimmed.length < LOCAL_TOOLS.WEB_FETCH_MIN_CONTENT) {
    return { suspicious: true, reason: 'very_short_response' }
  }
  return { suspicious: false }
}

// --- workingDir 기준 경로 해석 (세션별) ---
// 세션의 작업 디렉토리 기준으로 상대경로를 절대경로로 해석. 경계 밖이면 throw.
// workingDir 누락 시 throw (fallback 없음 — 호출자가 책임).
const resolveInWorkingDir = (relPath, workingDir) => {
  if (!workingDir) throw new Error('resolveInWorkingDir: workingDir required')
  const absolute = resolve(workingDir, relPath)
  if (!isWithinWorkspace(absolute, workingDir)) {
    throw new Error(t('error.access_denied', { path: relPath, workspace: workingDir }))
  }
  return absolute
}

// --- 도구 정의 ---
// 세션 context 의 ctx.resolvePath 가 workingDir 경계 검증 유일 창구.
// ctx 없이 호출하면 path 가 그대로 해석됨 (legacy/테스트 경로).
const resolveWithCtx = (rawPath, ctx) =>
  ctx?.resolvePath ? ctx.resolvePath(rawPath) : resolve(rawPath)

const createLocalTools = () => {
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
      handler: (rawArgs, ctx) => {
        const { path, maxLines, tailLines } = parseArgs(FileReadArgs, rawArgs, 'file_read')
        // ctx.resolvePath 우선 (세션 workingDir 기준). 없으면 legacy resolvePath (호환성).
        const resolved = resolveWithCtx(path, ctx)
        if (!existsSync(resolved)) throw new Error(t('error.file_not_found', { path, workspace: ctx?.workingDir ?? '?' }))
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
      handler: (rawArgs, ctx) => {
        const { path, content } = parseArgs(FileWriteArgs, rawArgs, 'file_write')
        const resolved = resolveWithCtx(path, ctx)
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
      handler: (rawArgs, ctx) => {
        const { path: dirPath } = parseArgs(FileListArgs, rawArgs, 'file_list')
        const resolved = resolveWithCtx(dirPath, ctx)
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
          const raw = await res.text()
          const contentType = res.headers.get('content-type') || ''
          // FP-62: HTML 이면 본문 텍스트만 추출 (templates/nav/script 제거).
          // Wikipedia 같은 SSR 페이지에서 truncate 가 본문 앞의 템플릿만 자르던 문제 해결.
          const text = looksLikeHtml(contentType, raw) ? htmlToText(raw, url) : raw
          const truncated = text.length > LOCAL_TOOLS.TEXT_TRUNCATE_LENGTH
            ? text.slice(0, LOCAL_TOOLS.TEXT_TRUNCATE_LENGTH) + '\n...(truncated)'
            : text
          // 파싱 후 텍스트 기반으로 품질 점검 (본문 길이 / 빈 페이지 시그널).
          const analysis = analyzeWebFetchResult(text)
          if (analysis.suspicious) {
            return `⚠ [web_fetch quality check: ${analysis.reason}] URL=${url}. ` +
              `The fetched content may not answer the user's request. ` +
              `Consider trying a different URL or responding directly.\n\n${truncated}`
          }
          return truncated
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
      handler: (rawArgs, ctx) => {
        const { command } = parseArgs(ShellExecArgs, rawArgs, 'shell_exec')
        // ctx.workingDir 있으면 session 기준으로 실행 (process.cwd 의존 제거).
        const execOpts = { encoding: 'utf-8', timeout: LOCAL_TOOLS.SHELL_TIMEOUT_MS }
        if (ctx?.workingDir) execOpts.cwd = ctx.workingDir
        try {
          return execSync(command, execOpts).trim()
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
 * `createLocalTools` — Creates built-in local tools (file_read/write/list, web_fetch, shell_exec, calculate).
 *
 * `isWithinWorkspace(path, workingDir)` — Lexical prefix 검증. workingDir 안쪽이면 true.
 *
 * `resolveInWorkingDir(relPath, workingDir)` — 상대경로 → 절대경로. 경계 밖이면 throw.
 */
export {
  createLocalTools, isWithinWorkspace, normalizePath, resolveInWorkingDir,
  analyzeWebFetchResult, htmlToText, looksLikeHtml,
}
