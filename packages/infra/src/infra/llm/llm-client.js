import { LLM } from '@presence/core/core/policies.js'
import { SseParser } from './sse-parser.js'

class LLMClient {
  #baseUrl
  #model
  #apiKey
  #fetchFn
  #timeoutMs
  #sseParser

  constructor({ baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o', apiKey, fetchFn, timeoutMs } = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
    this.#model = model
    this.#apiKey = apiKey || process.env.OPENAI_API_KEY
    this.#timeoutMs = timeoutMs || LLM.TIMEOUT_MS
    this.#fetchFn = fetchFn || globalThis.fetch
    this.#sseParser = new SseParser()
    if (!this.#fetchFn) {
      throw new Error('LLMClient: fetch not available. Provide fetchFn or use Node 18+.')
    }
  }

  get model() { return this.#model }

  setModel(model) {
    this.#model = model
  }

  async chat({ messages, tools, responseFormat, signal }) {
    const body = this.#buildBody({ messages, tools, responseFormat })
    return this.#withTimeout(signal, async ctrlSignal => {
      const response = await this.#postChat(body, ctrlSignal)
      return this.#parseChatResponse(response)
    })
  }

  // SSE 스트리밍 방식으로 LLM 호출.
  // onDelta({ delta, accumulated })가 토큰 단위로 호출된다.
  async chatStream({ messages, responseFormat, onDelta, signal }) {
    const body = this.#buildBody({ messages, responseFormat, stream: true })
    return this.#withTimeout(signal, async ctrlSignal => {
      const response = await this.#postChat(body, ctrlSignal)
      return this.#sseParser.parse(response, onDelta)
    })
  }

  async listModels() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LLM.LIST_MODELS_TIMEOUT_MS)
    try {
      const response = await this.#fetchFn(`${this.#baseUrl}/models`, {
        method: 'GET',
        headers: this.#authHeaders(),
        signal: controller.signal,
      })
      if (!response.ok) return []
      const data = await response.json()
      return (data.data || []).map(entry => entry.id).sort()
    } catch (_) {
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  // --- Request 조립 ---

  #buildBody({ messages, tools, responseFormat, stream = false }) {
    const body = { model: this.#model, messages }
    if (responseFormat) body.response_format = responseFormat
    if (tools && tools.length > 0) body.tools = tools.map(tool => ({ type: 'function', function: tool }))
    if (stream) body.stream = true
    return body
  }

  #authHeaders() {
    const headers = { 'Content-Type': 'application/json' }
    if (this.#apiKey) headers['Authorization'] = `Bearer ${this.#apiKey}`
    return headers
  }

  // timeout + external signal 통합
  async #withTimeout(extSignal, fn) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    if (extSignal) extSignal.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      return await fn(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  async #postChat(body, signal) {
    const response = await this.#fetchFn(`${this.#baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.#authHeaders(),
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`LLM API error ${response.status}: ${text}`)
    }
    return response
  }

  // --- Non-streaming 응답 파싱 ---

  async #parseChatResponse(response) {
    const data = await response.json()
    const choice = data.choices?.[0]
    if (!choice) throw new Error('LLM API: no choices in response')
    if (!choice.message) throw new Error('LLM API: choice has no message')
    if (choice.message.tool_calls) return { type: 'tool_calls', toolCalls: choice.message.tool_calls, raw: data }
    return { type: 'text', content: choice.message.content ?? '', raw: data }
  }
}

export { LLMClient }
