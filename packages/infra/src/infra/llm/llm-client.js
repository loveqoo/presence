import { LLM } from '@presence/core/core/policies.js'
import { SseParser } from './sse-parser.js'
import { listModelsFromApi } from './list-models.js'

// timeout + external signal 통합
const withTimeout = async (timeoutMs, extSignal, fn) => {
  const controller = new AbortController()
  const abortHandler = () => controller.abort()
  const timer = setTimeout(abortHandler, timeoutMs)
  if (extSignal) extSignal.addEventListener('abort', abortHandler, { once: true })
  try { return await fn(controller.signal) }
  finally { clearTimeout(timer) }
}

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
    if (!this.#fetchFn) throw new Error('LLMClient: fetch not available. Provide fetchFn or use Node 18+.')
  }

  get model() { return this.#model }
  setModel(model) { this.#model = model }

  async chat({ messages, tools, responseFormat, maxTokens, signal }) {
    const response = await this.#request({ messages, tools, responseFormat, maxTokens }, signal)
    return this.#parseChatResponse(response)
  }

  // SSE 스트리밍. onDelta({ delta, accumulated })가 토큰 단위로 호출.
  async chatStream({ messages, responseFormat, maxTokens, onDelta, signal }) {
    const response = await this.#request({ messages, responseFormat, maxTokens, stream: true }, signal)
    return this.#sseParser.parse(response, onDelta)
  }

  async listModels() {
    return listModelsFromApi(this.#fetchFn, this.#baseUrl, this.#authHeaders())
  }

  // body 조립 + timeout 적용 + HTTP 요청
  async #request(params, signal) {
    const body = { model: this.#model, messages: params.messages }
    if (params.responseFormat) body.response_format = params.responseFormat
    if (params.maxTokens) body.max_tokens = params.maxTokens
    if (params.tools?.length > 0) body.tools = params.tools.map(this.#toFunctionTool)
    if (params.stream) body.stream = true
    const headers = this.#authHeaders()
    return withTimeout(this.#timeoutMs, signal, async (ctrlSignal) => {
      const response = await this.#fetchFn(`${this.#baseUrl}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ctrlSignal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`LLM API error ${response.status}: ${text}`)
      }
      return response
    })
  }

  #toFunctionTool(tool) {
    return { type: 'function', function: tool }
  }

  async #parseChatResponse(response) {
    const data = await response.json()
    const choice = data.choices?.[0]
    if (!choice) throw new Error('LLM API: no choices in response')
    if (!choice.message) throw new Error('LLM API: choice has no message')
    if (choice.message.tool_calls) return { type: 'tool_calls', toolCalls: choice.message.tool_calls, raw: data }
    const truncated = choice.finish_reason === LLM.FINISH_REASON.LENGTH
    return { type: 'text', content: choice.message.content ?? '', truncated, raw: data }
  }

  #authHeaders() {
    const headers = { 'Content-Type': 'application/json' }
    if (this.#apiKey) headers['Authorization'] = `Bearer ${this.#apiKey}`
    return headers
  }
}

export { LLMClient }
