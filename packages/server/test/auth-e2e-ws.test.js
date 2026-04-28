/**
 * Auth E2E — WebSocket flows (AE13-15).
 *  AE13. WS 미인증 → 4001 close
 *  AE14. WS 인증 → init 메시지 수신
 *  AE15. WS Origin 검사 — 잘못된 Origin → 4003 close
 */

import { rmSync } from 'node:fs'
import { WebSocket } from 'ws'
import { assert, summary } from '../../../test/lib/assert.js'
import { connectWS, createMockLLM, delay, request, setupAuthServer } from './auth-e2e-helpers.js'

async function run() {
  console.log('Auth E2E — WebSocket flows (AE13-15)')

  const mockLLM = createMockLLM()
  const llmPort = await mockLLM.start()

  // AE13. WS 미인증 → close
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const closeCode = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`)
        ws.on('close', (code) => resolve(code))
        ws.on('error', () => resolve('error'))
        setTimeout(() => { ws.close(); resolve('timeout') }, 3000)
      })
      assert(closeCode === 4001 || closeCode === 'error', `AE13: unauthenticated WS → closed (code: ${closeCode})`)
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE14. WS 인증 → init 메시지 수신
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const token = loginRes.body.accessToken

      const { ws, messages } = await connectWS(port, { token })
      ws.send(JSON.stringify({ type: 'join', session_id: 'testuser-default' }))
      await delay(500)

      assert(ws !== null, 'AE14: authenticated WS connected')
      assert(messages.length > 0, 'AE14: received messages')
      assert(messages[0].type === 'init', 'AE14: first message is init')

      ws.close()
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  // AE15. WS Origin 검사 — 잘못된 Origin → 4003 close
  {
    const { server, shutdown, tmpDir } = await setupAuthServer(llmPort)
    const port = server.address().port
    try {
      const closeCode = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: { 'Origin': 'http://evil.example.com' },
        })
        ws.on('close', (code) => resolve(code))
        ws.on('error', () => resolve('error'))
        setTimeout(() => { ws.close(); resolve('timeout') }, 3000)
      })
      assert(closeCode === 4003 || closeCode === 4001, `AE15: bad origin WS → closed (code: ${closeCode})`)

      const loginRes = await request(port, 'POST', '/api/auth/login', { username: 'testuser', password: 'testpassword123' })
      const token = loginRes.body.accessToken
      const { ws: goodWs } = await connectWS(port, { token })
      assert(goodWs !== null, 'AE15: valid origin + auth → connected')
      goodWs.close()
    } finally {
      await shutdown()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  await mockLLM.close()
  summary()
}

run()
