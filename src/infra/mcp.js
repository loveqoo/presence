import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import fp from '../lib/fun-fp.js'

const { Either, once } = fp

// --- schema 검증 (Either) ---

const validateSchema = (inputSchema) =>
  (inputSchema && typeof inputSchema === 'object' && inputSchema.type === 'object')
    ? Either.Right(inputSchema)
    : Either.Left(inputSchema)

const ensureObjectSchema = (inputSchema) =>
  Either.fold(
    _ => ({ type: 'object', properties: {}, required: [] }),
    schema => schema,
    validateSchema(inputSchema),
  )

// --- result 변환 ---

const extractContent = (content) => {
  if (!Array.isArray(content) || content.length === 0) return ''
  const texts = content.filter(c => c.type === 'text').map(c => c.text)
  const nonText = content.filter(c => c.type !== 'text')
  const parts = []
  if (texts.length > 0) parts.push(texts.join('\n'))
  if (nonText.length > 0) {
    parts.push(`[${nonText.length}개 비텍스트 콘텐츠 생략 (${nonText.map(c => c.type).join(', ')})]`)
  }
  return parts.join('\n')
}

// --- MCP tool 변환 ---

const mcpToolToRegistryTool = (serverName, client) => (t) => ({
  name: `${serverName}_${t.name}`,
  description: t.description || '',
  parameters: ensureObjectSchema(t.inputSchema),
  source: serverName,
  handler: async (toolArgs) => {
    const result = await client.callTool({ name: t.name, arguments: toolArgs })
    return extractContent(result.content)
  },
})

// --- 자원 정리 (once로 idempotent) ---

const makeCleanup = (client, transport) => once(async () => {
  try { await client.close() } catch (_) {}
  try { if (transport.close) await transport.close() } catch (_) {}
})

// --- Transport 생성 ---

const createTransportForConfig = ({
  transport: type = 'stdio',
  command, args = [], env = {},
  url, headers = {},
  fetchFn,
}) => {
  switch (type) {
    case 'stdio':
      return new StdioClientTransport({ command, args, env })

    case 'sse':
      return new SSEClientTransport(
        new URL(url),
        {
          eventSourceInit: { fetch: fetchFn },
          requestInit: Object.keys(headers).length > 0
            ? { headers }
            : undefined,
        },
      )

    case 'streamable-http':
      return new StreamableHTTPClientTransport(
        new URL(url),
        {
          requestInit: Object.keys(headers).length > 0
            ? { headers }
            : undefined,
          fetch: fetchFn,
        },
      )

    default:
      throw new Error(`Unknown MCP transport: ${type}. Use "stdio", "sse", or "streamable-http".`)
  }
}

// --- MCP 서버 연결 ---

const connectMCPServer = async ({
  serverName,
  command,
  args = [],
  env = {},
  transport: transportType,
  url,
  headers,
  fetchFn,
  createClient = () => new Client({ name: 'presence', version: '1.0.0' }),
  createTransport = () => createTransportForConfig({ transport: transportType, command, args, env, url, headers, fetchFn }),
}) => {
  const transport = createTransport()
  const client = createClient()
  const cleanup = makeCleanup(client, transport)

  let mcpTools
  try {
    await client.connect(transport)
    ;({ tools: mcpTools } = await client.listTools())
  } catch (e) {
    await cleanup()
    throw e
  }

  const tools = mcpTools.map(mcpToolToRegistryTool(serverName, client))

  return { serverName, tools, close: cleanup }
}

export {
  connectMCPServer, extractContent, ensureObjectSchema, validateSchema,
  mcpToolToRegistryTool, createTransportForConfig,
}
