import { LLMClient } from '../../src/infra/llm.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

// Mock fetch factory
const mockFetch = (handler) => async (url, opts) => {
  const body = JSON.parse(opts.body)
  const result = handler(url, opts, body)
  return {
    ok: result.ok ?? true,
    status: result.status ?? 200,
    json: async () => result.json,
    text: async () => result.text ?? '',
  }
}

async function run() {
  console.log('LLM client tests')

  // 1. Basic chat: sends correct request, returns text content
  {
    let captured = null
    const client = new LLMClient({
      apiKey: 'test-key',
      model: 'gpt-4o',
      fetchFn: mockFetch((url, opts, body) => {
        captured = { url, body, headers: opts.headers }
        return { json: { choices: [{ message: { content: 'hello back' } }] } }
      })
    })

    const result = await client.chat({
      messages: [{ role: 'user', content: 'hello' }],
    })

    assert(captured.url.endsWith('/chat/completions'), 'chat: correct endpoint')
    assert(captured.headers['Authorization'] === 'Bearer test-key', 'chat: auth header')
    assert(captured.body.model === 'gpt-4o', 'chat: model in body')
    assert(captured.body.messages[0].content === 'hello', 'chat: messages in body')
    assert(result.type === 'text', 'chat: result type is text')
    assert(result.content === 'hello back', 'chat: result content')
  }

  // 2. responseFormat passed through
  {
    let captured = null
    const client = new LLMClient({
      apiKey: 'k',
      fetchFn: mockFetch((_, __, body) => {
        captured = body
        return { json: { choices: [{ message: { content: '{}' } }] } }
      })
    })

    await client.chat({
      messages: [{ role: 'user', content: 'plan' }],
      responseFormat: { type: 'json_schema', json_schema: { name: 'test' } },
    })

    assert(captured.response_format.type === 'json_schema', 'responseFormat: type passed')
    assert(captured.response_format.json_schema.name === 'test', 'responseFormat: schema passed')
  }

  // 3. tools mapped to OpenAI function format
  {
    let captured = null
    const client = new LLMClient({
      apiKey: 'k',
      fetchFn: mockFetch((_, __, body) => {
        captured = body
        return { json: { choices: [{ message: { content: 'ok' } }] } }
      })
    })

    await client.chat({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'my_tool', description: 'desc', parameters: { type: 'object' } }],
    })

    assert(captured.tools.length === 1, 'tools: 1 tool')
    assert(captured.tools[0].type === 'function', 'tools: wrapped as function type')
    assert(captured.tools[0].function.name === 'my_tool', 'tools: function name preserved')
  }

  // 4. No tools/responseFormat → fields omitted from body
  {
    let captured = null
    const client = new LLMClient({
      apiKey: 'k',
      fetchFn: mockFetch((_, __, body) => {
        captured = body
        return { json: { choices: [{ message: { content: 'ok' } }] } }
      })
    })

    await client.chat({ messages: [{ role: 'user', content: 'hi' }] })

    assert(captured.response_format === undefined, 'no responseFormat: omitted')
    assert(captured.tools === undefined, 'no tools: omitted')
  }

  // 5. tool_calls response
  {
    const client = new LLMClient({
      apiKey: 'k',
      fetchFn: mockFetch(() => ({
        json: {
          choices: [{
            message: {
              tool_calls: [{ id: 'tc1', function: { name: 'search', arguments: '{"q":"test"}' } }]
            }
          }]
        }
      }))
    })

    const result = await client.chat({ messages: [{ role: 'user', content: 'x' }] })
    assert(result.type === 'tool_calls', 'tool_calls: result type')
    assert(result.toolCalls[0].function.name === 'search', 'tool_calls: function name')
  }

  // 6. API error → throws with status and body
  {
    const client = new LLMClient({
      apiKey: 'k',
      fetchFn: mockFetch(() => ({
        ok: false,
        status: 429,
        text: 'rate limited',
      }))
    })

    try {
      await client.chat({ messages: [{ role: 'user', content: 'x' }] })
      assert(false, 'API error: should throw')
    } catch (e) {
      assert(e.message.includes('429'), 'API error: includes status code')
      assert(e.message.includes('rate limited'), 'API error: includes body')
    }
  }

  // 7. Empty choices → throws
  {
    const client = new LLMClient({
      apiKey: 'k',
      fetchFn: mockFetch(() => ({ json: { choices: [] } }))
    })

    try {
      await client.chat({ messages: [{ role: 'user', content: 'x' }] })
      assert(false, 'empty choices: should throw')
    } catch (e) {
      assert(e.message.includes('no choices'), 'empty choices: correct error')
    }
  }

  // 8. Custom baseUrl (trailing slash stripped)
  {
    let capturedUrl = null
    const client = new LLMClient({
      baseUrl: 'http://localhost:1234/v1/',
      apiKey: 'k',
      fetchFn: mockFetch((url) => {
        capturedUrl = url
        return { json: { choices: [{ message: { content: 'ok' } }] } }
      })
    })

    await client.chat({ messages: [{ role: 'user', content: 'x' }] })
    assert(capturedUrl === 'http://localhost:1234/v1/chat/completions', 'custom baseUrl: correct URL')
  }

  // 9. No fetchFn and no global fetch → throws at construction
  {
    const originalFetch = globalThis.fetch
    globalThis.fetch = undefined
    try {
      new LLMClient({ apiKey: 'k' })
      assert(false, 'no fetch: should throw')
    } catch (e) {
      assert(e.message.includes('fetch not available'), 'no fetch: correct error')
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run()
