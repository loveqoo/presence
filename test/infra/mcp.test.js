import { connectMCPServer, extractContent, ensureObjectSchema, validateSchema, createTransportForConfig } from '@presence/infra/infra/mcp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import fp from '@presence/core/lib/fun-fp.js'
const { Either } = fp
import { assert, summary } from '../lib/assert.js'

// --- mock factory helpers ---

const mockClient = ({ tools = [], callResult = { content: [] } } = {}) => {
  const calls = []
  let connected = false
  let closed = false
  return {
    connect: async () => { connected = true },
    listTools: async () => ({ tools }),
    callTool: async (req) => { calls.push(req); return callResult },
    close: async () => { closed = true },
    _state: { get connected() { return connected }, get closed() { return closed }, calls },
  }
}

const mockTransport = () => {
  let closed = false
  return {
    close: async () => { closed = true },
    get _closed() { return closed },
  }
}

async function run() {
  console.log('MCP integration tests')

  // ===========================================
  // extractContent 단위 테스트
  // ===========================================

  {
    assert(extractContent([{ type: 'text', text: 'hello' }]) === 'hello',
      'extractContent: single text')
  }

  {
    const result = extractContent([
      { type: 'text', text: 'line1' },
      { type: 'text', text: 'line2' },
    ])
    assert(result === 'line1\nline2', 'extractContent: multiple texts joined')
  }

  {
    const result = extractContent([
      { type: 'text', text: 'data' },
      { type: 'image', data: '...' },
    ])
    assert(result.includes('data'), 'extractContent: text preserved')
    assert(result.includes('1개 비텍스트'), 'extractContent: non-text notice')
    assert(result.includes('image'), 'extractContent: mentions type')
  }

  {
    assert(extractContent([]) === '', 'extractContent: empty array')
    assert(extractContent(null) === '', 'extractContent: null')
    assert(extractContent(undefined) === '', 'extractContent: undefined')
  }

  {
    const result = extractContent([{ type: 'image', data: '...' }])
    assert(result.includes('1개 비텍스트'), 'extractContent: only non-text')
    assert(!result.startsWith('\n'), 'extractContent: no leading newline when no text')
  }

  // ===========================================
  // ensureObjectSchema 단위 테스트
  // ===========================================

  // validateSchema returns Either
  {
    const schema = { type: 'object', properties: { q: { type: 'string' } } }
    assert(Either.isRight(validateSchema(schema)), 'validateSchema: valid → Right')
    assert(Either.isLeft(validateSchema(null)), 'validateSchema: null → Left')
    assert(Either.isLeft(validateSchema({ type: 'string' })), 'validateSchema: non-object → Left')
  }

  // ensureObjectSchema uses Either internally, returns plain value
  {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
    assert(ensureObjectSchema(schema) === schema, 'ensureObjectSchema: valid schema passed through')
  }

  {
    const result = ensureObjectSchema(null)
    assert(result.type === 'object', 'ensureObjectSchema: null → fallback')
  }

  {
    const result = ensureObjectSchema({ type: 'string' })
    assert(result.type === 'object', 'ensureObjectSchema: non-object type → fallback')
  }

  {
    const result = ensureObjectSchema(undefined)
    assert(result.type === 'object', 'ensureObjectSchema: undefined → fallback')
  }

  // ===========================================
  // connectMCPServer 테스트
  // ===========================================

  // 도구 목록 변환 + 이름 prefix
  {
    const client = mockClient({
      tools: [
        { name: 'list_prs', description: 'List PRs', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_issue', description: 'Get issue', inputSchema: { type: 'object', properties: {} } },
      ],
    })
    const transport = mockTransport()

    const conn = await connectMCPServer({
      serverName: 'github',
      createClient: () => client,
      createTransport: () => transport,
    })

    assert(conn.serverName === 'github', 'connect: serverName preserved')
    assert(conn.tools.length === 2, 'connect: 2 tools registered')
    assert(conn.tools[0].name === 'github_list_prs', 'connect: name prefixed (1)')
    assert(conn.tools[1].name === 'github_get_issue', 'connect: name prefixed (2)')
    assert(conn.tools[0].description === 'List PRs', 'connect: description preserved')
    assert(conn.tools[0].source === 'github', 'connect: source set')
  }

  // handler → callTool 위임
  {
    const client = mockClient({
      tools: [{ name: 'search', inputSchema: { type: 'object', properties: {} } }],
      callResult: { content: [{ type: 'text', text: 'found 3' }] },
    })
    const transport = mockTransport()

    const conn = await connectMCPServer({
      serverName: 'test',
      createClient: () => client,
      createTransport: () => transport,
    })

    const result = await conn.tools[0].handler({ q: 'hello' })

    assert(result === 'found 3', 'handler: returns extracted text')
    assert(client._state.calls.length === 1, 'handler: callTool called once')
    assert(client._state.calls[0].name === 'search', 'handler: original name (no prefix) sent to server')
    assert(client._state.calls[0].arguments.q === 'hello', 'handler: arguments forwarded')
  }

  // schema fallback
  {
    const client = mockClient({
      tools: [
        { name: 'loose', description: 'Loose schema', inputSchema: { type: 'string' } },
        { name: 'none', description: 'No schema' },
      ],
    })
    const transport = mockTransport()

    const conn = await connectMCPServer({
      serverName: 's',
      createClient: () => client,
      createTransport: () => transport,
    })

    assert(conn.tools[0].parameters.type === 'object', 'schema fallback: non-object → object')
    assert(conn.tools[1].parameters.type === 'object', 'schema fallback: missing → object')
  }

  // close: client + transport 정리
  {
    const client = mockClient({ tools: [] })
    const transport = mockTransport()

    const conn = await connectMCPServer({
      serverName: 'x',
      createClient: () => client,
      createTransport: () => transport,
    })

    await conn.close()
    assert(client._state.closed, 'close: client closed')
    assert(transport._closed, 'close: transport closed')
  }

  // close: idempotent
  {
    const client = mockClient({ tools: [] })
    const transport = mockTransport()

    const conn = await connectMCPServer({
      serverName: 'x',
      createClient: () => client,
      createTransport: () => transport,
    })

    await conn.close()
    await conn.close()  // 두 번째 호출 → 에러 없이 통과
    assert(true, 'close: idempotent (no error on second call)')
  }

  // connect 실패 → 에러 전파 + client/transport 정리
  {
    let clientClosed = false
    let transportClosed = false
    try {
      await connectMCPServer({
        serverName: 'broken',
        createClient: () => ({
          connect: async () => { throw new Error('connection refused') },
          close: async () => { clientClosed = true },
        }),
        createTransport: () => ({ close: async () => { transportClosed = true } }),
      })
      assert(false, 'connect failure: should throw')
    } catch (e) {
      assert(e.message === 'connection refused', 'connect failure: error propagated')
      assert(clientClosed, 'connect failure: client cleaned up')
      assert(transportClosed, 'connect failure: transport cleaned up')
    }
  }

  // listTools 실패 → 에러 전파 + client/transport 정리
  {
    let clientClosed = false
    let transportClosed = false
    try {
      await connectMCPServer({
        serverName: 'broken',
        createClient: () => ({
          connect: async () => {},
          listTools: async () => { throw new Error('list failed') },
          close: async () => { clientClosed = true },
        }),
        createTransport: () => ({ close: async () => { transportClosed = true } }),
      })
      assert(false, 'listTools failure: should throw')
    } catch (e) {
      assert(e.message === 'list failed', 'listTools failure: error propagated')
      assert(clientClosed, 'listTools failure: client cleaned up')
      assert(transportClosed, 'listTools failure: transport cleaned up')
    }
  }

  // handler 호출 실패 → 에러 전파
  {
    const client = mockClient({ tools: [{ name: 'fail', inputSchema: { type: 'object', properties: {} } }] })
    client.callTool = async () => { throw new Error('tool error') }
    const transport = mockTransport()

    const conn = await connectMCPServer({
      serverName: 't',
      createClient: () => client,
      createTransport: () => transport,
    })

    try {
      await conn.tools[0].handler({})
      assert(false, 'handler failure: should throw')
    } catch (e) {
      assert(e.message === 'tool error', 'handler failure: error propagated')
    }
  }

  // 빈 도구 목록
  {
    const client = mockClient({ tools: [] })
    const conn = await connectMCPServer({
      serverName: 'empty',
      createClient: () => client,
      createTransport: () => mockTransport(),
    })
    assert(conn.tools.length === 0, 'empty server: 0 tools')
  }

  // ===========================================
  // createTransportForConfig 테스트
  // ===========================================

  // stdio (기본값)
  {
    const t = createTransportForConfig({ command: 'echo', args: ['hello'] })
    assert(t instanceof StdioClientTransport, 'transport: default → StdioClientTransport')
  }

  {
    const t = createTransportForConfig({ transport: 'stdio', command: 'echo' })
    assert(t instanceof StdioClientTransport, 'transport: explicit stdio → StdioClientTransport')
  }

  // SSE
  {
    const t = createTransportForConfig({ transport: 'sse', url: 'http://localhost:3000/mcp/sse' })
    assert(t instanceof SSEClientTransport, 'transport: sse → SSEClientTransport')
  }

  // StreamableHTTP
  {
    const t = createTransportForConfig({ transport: 'streamable-http', url: 'http://localhost:3000/mcp' })
    assert(t instanceof StreamableHTTPClientTransport, 'transport: streamable-http → StreamableHTTPClientTransport')
  }

  // unknown → 에러
  {
    try {
      createTransportForConfig({ transport: 'unknown' })
      assert(false, 'transport: unknown → should throw')
    } catch (e) {
      assert(e.message.includes('Unknown MCP transport'), 'transport: unknown → error message')
    }
  }

  // SSE + headers
  {
    const t = createTransportForConfig({
      transport: 'sse',
      url: 'http://localhost:3000/mcp/sse',
      headers: { 'Authorization': 'Bearer test-token' },
    })
    assert(t instanceof SSEClientTransport, 'transport: sse+headers → SSEClientTransport')
  }

  // connectMCPServer: transport=sse config 경유 (mock으로 실제 연결 없이)
  {
    const client = mockClient({ tools: [{ name: 'remote_tool', inputSchema: { type: 'object', properties: {} } }] })
    const transport = mockTransport()

    const conn = await connectMCPServer({
      serverName: 'remote',
      transport: 'sse',
      url: 'http://localhost:3000/mcp/sse',
      createClient: () => client,
      createTransport: () => transport,
    })

    assert(conn.serverName === 'remote', 'sse connect: serverName preserved')
    assert(conn.tools.length === 1, 'sse connect: tools registered')
    assert(conn.tools[0].name === 'remote_remote_tool', 'sse connect: name prefixed')
  }

  summary()
}

run()
