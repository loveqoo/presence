/**
 * Auth E2E 공통 setup — auth-e2e-{rest,ws,admin}.test.js 가 공유.
 *
 * createMockLLM() — JSON LLM 응답 mock (HTTP server)
 * request(port, method, path, body, opts) — fetch 대신 http.request
 * connectWS(port, opts) — WebSocket 연결 + 메시지 캡처
 * setupAuthServer(llmPort) — tmpDir + 인스턴스 + 사용자 + startServer
 *
 * 분할 이력: auth-e2e.test.js 가 18 boot 순차 = 18.4s 단일 wall.
 * 3 파일로 쪼개 병렬 풀이 흡수.
 */

import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { startServer } from '@presence/server'
import { createUserStore } from '@presence/infra/infra/auth/user-store.js'
import { ensureSecret } from '@presence/infra/infra/auth/token.js'

export const delay = (ms) => new Promise(r => setTimeout(r, ms))

export const createMockLLM = () => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const content = JSON.stringify({ type: 'direct_response', message: '응답' })
      const parsed = JSON.parse(body)
      if (parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content } }] }))
      }
    })
  })
  return {
    start: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise(r => server.close(r)),
  }
}

export const request = (port, method, path, body, { token, cookie } = {}) =>
  new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(cookie ? { 'Cookie': cookie } : {}),
    }
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = ''
      const setCookie = res.headers['set-cookie'] || []
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf), setCookie }) }
        catch { resolve({ status: res.statusCode, body: buf, setCookie }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })

export const connectWS = (port, { token } = {}) =>
  new Promise((resolve, reject) => {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    const messages = []
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())))
    ws.on('open', () => resolve({ ws, messages }))
    ws.on('error', reject)
    ws.on('close', (code) => resolve({ ws: null, messages, closeCode: code }))
    setTimeout(() => resolve({ ws: null, messages, closeCode: 'timeout' }), 3000)
  })

// 테스트 환경: 인스턴스 설정 + 사용자 등록 + 서버 시작.
// PRESENCE_DIR 환경변수 mutate — 같은 Node 프로세스 내 시퀀셜 호출만 안전.
// 파일 단위 격리는 execFile 가 제공.
export const setupAuthServer = async (llmPort) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'auth-e2e-'))
  const instanceId = 'auth-test'
  mkdirSync(join(tmpDir, 'instances'), { recursive: true })

  writeFileSync(join(tmpDir, 'instances', `${instanceId}.json`), JSON.stringify({
    memory: { path: join(tmpDir, 'memory') },
  }))
  writeFileSync(join(tmpDir, 'server.json'), JSON.stringify({
    llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 5000 },
    embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
    locale: 'ko', maxIterations: 5,
    mcp: [],
    scheduler: { enabled: false, pollIntervalMs: 60000, todoReview: { enabled: false, cron: '0 9 * * *' } },
    delegatePolling: { intervalMs: 60000 },
    prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
  }))

  ensureSecret({ basePath: tmpDir })
  const userStore = createUserStore({ basePath: tmpDir })
  await userStore.addUser('testuser', 'testpassword123')
  await userStore.changePassword('testuser', 'testpassword123')

  const origDir = process.env.PRESENCE_DIR
  process.env.PRESENCE_DIR = tmpDir

  const { loadUserMerged } = await import('@presence/infra/infra/config-loader.js')
  const config = loadUserMerged(instanceId, { basePath: tmpDir })
  const result = await startServer(config, { port: 0, persistenceCwd: tmpDir, instanceId })

  const origShutdown = result.shutdown
  const shutdownWithCleanup = async () => {
    await origShutdown()
    if (origDir) process.env.PRESENCE_DIR = origDir
    else delete process.env.PRESENCE_DIR
  }

  return { ...result, shutdown: shutdownWithCleanup, tmpDir, instanceId, userStore }
}
