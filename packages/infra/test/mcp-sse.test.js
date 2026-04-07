import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { connectMCPServer } from '@presence/infra/infra/mcp/connection.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { z } from 'zod'
import { assert, summary } from '../../../test/lib/assert.js'

// --- 미니 MCP SSE 서버 ---
// Node http + SSEServerTransport로 테스트용 서버 구성

const createTestSSEServer = () => {
  const transports = {}

  // 세션마다 새 McpServer 생성 (MCP SDK 제약: 1 server ↔ 1 transport)
  const createSessionServer = () => {
    const s = new McpServer({ name: 'test-sse', version: '1.0.0' })
    s.tool('echo', { message: z.string() }, async ({ message }) => ({
      content: [{ type: 'text', text: `Echo: ${message}` }],
    }))
    s.tool('ping', {}, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    return s
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)

    // GET /sse → SSE 스트림 시작
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res)
      transports[transport.sessionId] = transport
      res.on('close', () => { delete transports[transport.sessionId] })
      await createSessionServer().connect(transport)
      return
    }

    // POST /messages?sessionId=xxx → 메시지 수신
    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId')
      const transport = transports[sessionId]
      if (!transport) {
        res.writeHead(400)
        res.end('Unknown session')
        return
      }
      await transport.handlePostMessage(req, res)
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  return {
    start: () => new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        resolve({ port, server })
      })
    }),
    close: () => new Promise(resolve => {
      Object.values(transports).forEach(t => { try { t.close?.() } catch (_) {} })
      server.close(resolve)
    }),
  }
}

async function run() {
  console.log('MCP SSE integration tests')

  const testServer = createTestSSEServer()
  const { port } = await testServer.start()
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    // 1. SSEClientTransport 직접 연결 → listTools
    {
      const transport = new SSEClientTransport(new URL(`${baseUrl}/sse`))
      const client = new Client({ name: 'test', version: '1.0.0' })
      await client.connect(transport)

      const { tools } = await client.listTools()
      assert(tools.length === 2, 'SSE direct: 2 tools listed')
      assert(tools.some(t => t.name === 'echo'), 'SSE direct: echo tool found')
      assert(tools.some(t => t.name === 'ping'), 'SSE direct: ping tool found')

      await client.close()
      await transport.close()
    }

    // 2. SSEClientTransport → callTool
    {
      const transport = new SSEClientTransport(new URL(`${baseUrl}/sse`))
      const client = new Client({ name: 'test', version: '1.0.0' })
      await client.connect(transport)

      const result = await client.callTool({ name: 'echo', arguments: { message: '안녕하세요' } })
      assert(result.content[0].text === 'Echo: 안녕하세요', 'SSE direct: echo returns correct text')

      const pingResult = await client.callTool({ name: 'ping', arguments: {} })
      assert(pingResult.content[0].text === 'pong', 'SSE direct: ping returns pong')

      await client.close()
      await transport.close()
    }

    // 3. connectMCPServer(transport: 'sse') → 도구 목록 + handler
    {
      const conn = await connectMCPServer({
        serverName: 'test-remote',
        transport: 'sse',
        url: `${baseUrl}/sse`,
      })

      assert(conn.serverName === 'test-remote', 'connectMCPServer SSE: serverName')
      assert(conn.tools.length === 2, 'connectMCPServer SSE: 2 tools')
      assert(conn.tools.some(t => t.name === 'test-remote_echo'), 'connectMCPServer SSE: echo prefixed')
      assert(conn.tools.some(t => t.name === 'test-remote_ping'), 'connectMCPServer SSE: ping prefixed')

      // handler 호출
      const echoTool = conn.tools.find(t => t.name === 'test-remote_echo')
      const result = await echoTool.handler({ message: 'SSE 테스트' })
      assert(result === 'Echo: SSE 테스트', 'connectMCPServer SSE: handler returns result')

      const pingTool = conn.tools.find(t => t.name === 'test-remote_ping')
      const pingResult = await pingTool.handler({})
      assert(pingResult === 'pong', 'connectMCPServer SSE: ping handler works')

      await conn.close()
    }

    // 4. 잘못된 URL → 연결 실패 + 에러 전파
    {
      try {
        await connectMCPServer({
          serverName: 'bad',
          transport: 'sse',
          url: 'http://127.0.0.1:1/nonexistent',
        })
        assert(false, 'SSE bad URL: should throw')
      } catch (e) {
        assert(e != null, 'SSE bad URL: error thrown')
      }
    }

    // 5. headers 전달 확인 (서버에서 거부하지 않으므로 연결 성공으로 간접 확인)
    {
      const conn = await connectMCPServer({
        serverName: 'with-headers',
        transport: 'sse',
        url: `${baseUrl}/sse`,
        headers: { 'X-Test-Header': 'presence' },
      })
      assert(conn.tools.length === 2, 'SSE headers: connection works with custom headers')
      await conn.close()
    }

  } finally {
    await testServer.close()
  }

  summary()
}

run()
