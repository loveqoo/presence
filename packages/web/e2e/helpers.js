import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Mock LLM — 테스트별로 handler를 교체할 수 있는 mutable reference
export const createMockLLM = () => {
  const calls = []
  let handler = () => JSON.stringify({ type: 'direct_response', message: 'default' })

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      calls.push(parsed)
      const response = handler(parsed, calls.length)
      const content = typeof response === 'string' ? response : JSON.stringify(response)
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
    calls,
    setHandler: (h) => { handler = h },
    resetCalls: () => { calls.length = 0 },
    start: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

export const startTestServer = async (mockLLM, { port = 3200 } = {}) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'presence-pw-'))
  const llmPort = await mockLLM.start()

  const config = {
    llm: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: 'test', apiKey: 'k', responseFormat: 'json_object', maxRetries: 0, timeoutMs: 10000 },
    embed: { provider: 'openai', baseUrl: null, apiKey: null, model: null, dimensions: 256 },
    locale: 'ko', maxIterations: 5,
    memory: { path: join(tmpDir, 'memory') },
    mcp: [],
    heartbeat: { enabled: false, intervalMs: 300000, prompt: '' },
    delegatePolling: { intervalMs: 60000 },
    prompt: { maxContextTokens: 8000, reservedOutputTokens: 1000, maxContextChars: null, reservedOutputChars: null },
  }

  const { startServer } = await import('../../src/server/index.js')
  const { server, shutdown } = await startServer(config, { port, persistenceCwd: tmpDir })

  return {
    port: server.address().port,
    cleanup: async () => {
      await shutdown()
      await mockLLM.close()
      const { rmSync } = await import('node:fs')
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}
