import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

// Transport 팩토리 — SDK transport 생성을 다형성으로 통일

class McpTransport {
  create() { throw new Error('Not implemented: create') }
}

class StdioTransport extends McpTransport {
  #command
  #args

  constructor({ command, args = [] }) {
    super()
    this.#command = command
    this.#args = args
  }

  create() {
    return new StdioClientTransport({ command: this.#command, args: this.#args })
  }
}

class SseTransport extends McpTransport {
  #url
  #headers
  #fetchFn

  constructor({ url, headers = {}, fetchFn }) {
    super()
    this.#url = url
    this.#headers = headers
    this.#fetchFn = fetchFn
  }

  create() {
    return new SSEClientTransport(
      new URL(this.#url),
      {
        eventSourceInit: { fetch: this.#fetchFn },
        requestInit: Object.keys(this.#headers).length > 0
          ? { headers: this.#headers }
          : undefined,
      },
    )
  }
}

class StreamableHttpTransport extends McpTransport {
  #url
  #headers
  #fetchFn

  constructor({ url, headers = {}, fetchFn }) {
    super()
    this.#url = url
    this.#headers = headers
    this.#fetchFn = fetchFn
  }

  create() {
    return new StreamableHTTPClientTransport(
      new URL(this.#url),
      {
        requestInit: Object.keys(this.#headers).length > 0
          ? { headers: this.#headers }
          : undefined,
        fetch: this.#fetchFn,
      },
    )
  }
}

const TRANSPORT_CLASSES = Object.freeze({
  'stdio': StdioTransport,
  'sse': SseTransport,
  'streamable-http': StreamableHttpTransport,
})

const createTransportR = Reader.asks(({ transport: type = 'stdio', ...config }) => {
  const TransportClass = TRANSPORT_CLASSES[type]
  if (!TransportClass) {
    throw new Error(`Unknown MCP transport: ${type}. Use "stdio", "sse", or "streamable-http".`)
  }
  return new TransportClass(config).create()
})

// 레거시 브릿지
const createTransport = (config) => createTransportR.run(config)

export {
  McpTransport, StdioTransport, SseTransport, StreamableHttpTransport,
  TRANSPORT_CLASSES, createTransportR, createTransport,
}
