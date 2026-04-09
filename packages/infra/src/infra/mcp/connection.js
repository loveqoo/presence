import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import fp from '@presence/core/lib/fun-fp.js'
import { createTransport } from './transport.js'
import { ensureObjectSchema } from './schema.js'
import { extractContent } from './content.js'

const { Reader, once } = fp

// MCP tool → registry tool 변환
const mcpToolToRegistryTool = (serverName, client) => (tool) => ({
  name: `${serverName}_${tool.name}`,
  description: tool.description || '',
  parameters: ensureObjectSchema(tool.inputSchema),
  source: serverName,
  handler: async (toolArgs) => {
    const result = await client.callTool({ name: tool.name, arguments: toolArgs })
    return extractContent(result.content)
  },
})

// 자원 정리 (once로 idempotent)
const makeCleanup = (client, transport) => once(async () => {
  try { await client.close() } catch (_) {}
  try { if (transport.close) await transport.close() } catch (_) {}
})

// Reader env: { serverName, ...transportConfig }
// 테스트 seam: createClient, createTransport를 env로 override 가능
const connectMCPServerR = Reader.asks(async ({
  serverName,
  createClient: clientFactory,
  createTransport: transportFactory,
  ...transportConfig
}) => {
  const transport = transportFactory
    ? transportFactory()
    : createTransport(transportConfig)
  const client = clientFactory
    ? clientFactory()
    : new Client({ name: 'presence', version: '1.0.0' })
  const cleanup = makeCleanup(client, transport)

  let mcpTools
  try {
    await client.connect(transport)
    ;({ tools: mcpTools } = await client.listTools())
  } catch (error) {
    await cleanup()
    throw error
  }

  const tools = mcpTools.map(mcpToolToRegistryTool(serverName, client))

  return { serverName, tools, close: cleanup }
})

// 레거시 브릿지
const connectMCPServer = (config) => connectMCPServerR.run(config)

export { connectMCPServerR, connectMCPServer }
