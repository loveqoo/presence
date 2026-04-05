/**
 * OpenAI-compatible LLM client supporting chat completions, SSE streaming, and model listing.
 */
class LLMClient {
  /**
   * @param {{ baseUrl?: string, model?: string, apiKey?: string, fetchFn?: Function, timeoutMs?: number }} [options]
   */
  constructor({ baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o', apiKey, fetchFn, timeoutMs = 120_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.model = model
    this.apiKey = apiKey || process.env.OPENAI_API_KEY
    this.timeoutMs = timeoutMs
    this.fetchFn = fetchFn || globalThis.fetch
    if (!this.fetchFn) {
      throw new Error('LLMClient: fetch not available. Provide fetchFn or use Node 18+.')
    }
  }

  /**
   * Sends a chat completion request and returns the first choice as text or tool_calls.
   * @param {{ messages: object[], tools?: object[], responseFormat?: object, signal?: AbortSignal }} params
   * @returns {Promise<{ type: 'text', content: string, raw: object } | { type: 'tool_calls', toolCalls: object[], raw: object }>}
   */
  async chat({ messages, tools, responseFormat, signal }) {
    const body = this.buildBody({ messages, tools, responseFormat })
    return this.withTimeout(signal, async ctrlSignal => {
      const res = await this.postChat(body, ctrlSignal)
      return this.parseChatResponse(res)
    })
  }

  /**
   * SSE 스트리밍 방식으로 LLM 호출.
   * onDelta({ delta, accumulated })가 토큰 단위로 호출된다.
   * 반환값은 chat()과 동일: { type: 'text', content }
   */
  async chatStream({ messages, responseFormat, onDelta, signal }) {
    const body = this.buildBody({ messages, responseFormat, stream: true })
    return this.withTimeout(signal, async ctrlSignal => {
      const res = await this.postChat(body, ctrlSignal)
      return this.parseStreamResponse(res, onDelta)
    })
  }

  /**
   * Updates the model used for subsequent requests.
   * @param {string} model
   */
  setModel(model) {
    this.model = model
  }

  /**
   * Fetches available model ids from the /models endpoint. Returns [] on failure.
   * @returns {Promise<string[]>}
   */
  async listModels() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const res = await this.fetchFn(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: controller.signal,
      })
      if (!res.ok) return []
      const data = await res.json()
      return (data.data || []).map(m => m.id).sort()
    } catch (_) {
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  // --- Request 조립 ---

  buildBody({ messages, tools, responseFormat, stream = false }) {
    const body = { model: this.model, messages }
    if (responseFormat) body.response_format = responseFormat
    if (tools && tools.length > 0) body.tools = tools.map(t => ({ type: 'function', function: t }))
    if (stream) body.stream = true
    return body
  }

  authHeaders() {
    const h = { 'Content-Type': 'application/json' }
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`
    return h
  }

  // timeout + external signal 통합. fn에 abort 가능한 signal 전달.
  async withTimeout(extSignal, fn) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    if (extSignal) extSignal.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      return await fn(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  async postChat(body, signal) {
    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`LLM API error ${res.status}: ${text}`)
    }
    return res
  }

  // --- Non-streaming 응답 파싱 ---

  async parseChatResponse(res) {
    const data = await res.json()
    const choice = data.choices?.[0]
    if (!choice) throw new Error('LLM API: no choices in response')
    if (!choice.message) throw new Error('LLM API: choice has no message')
    if (choice.message.tool_calls) return { type: 'tool_calls', toolCalls: choice.message.tool_calls, raw: data }
    return { type: 'text', content: choice.message.content ?? '', raw: data }
  }

  // --- SSE 스트림 파싱 ---

  async parseStreamResponse(res, onDelta) {
    // 서버가 스트리밍 미지원 시 일반 JSON 응답 처리
    if (!res.body || !res.body.getReader) {
      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? ''
      if (onDelta) onDelta({ delta: content, accumulated: content })
      return { type: 'text', content }
    }
    const content = await this.drainSSE(res.body.getReader(), onDelta)
    return { type: 'text', content }
  }

  // reader에서 chunk 읽어 줄 단위로 파싱. streamDone 감지 시 reader cancel.
  async drainSSE(reader, onDelta) {
    const decoder = new TextDecoder()
    let buffer = ''
    let accumulated = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      const res = this.consumeSSELines(lines, accumulated, onDelta)
      accumulated = res.accumulated
      if (res.streamDone) { reader.cancel().catch(() => {}); break }
    }
    return accumulated
  }

  // 한 배치의 SSE 라인 소비. 중간에 [DONE]이나 finish_reason이 나오면 streamDone.
  consumeSSELines(lines, accumulated, onDelta) {
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') return { accumulated, streamDone: true }
      const parsed = this.parseSSEChunk(data, accumulated, onDelta)
      if (!parsed) continue
      accumulated = parsed.accumulated
      if (parsed.streamDone) return { accumulated, streamDone: true }
    }
    return { accumulated, streamDone: false }
  }

  // 한 SSE chunk 파싱: JSON decode → delta 추출 → onDelta 호출. JSON 에러는 조용히 스킵.
  parseSSEChunk(data, accumulated, onDelta) {
    try {
      const chunk = JSON.parse(data)
      const delta = chunk.choices?.[0]?.delta?.content
      const next = delta ? accumulated + delta : accumulated
      if (delta && onDelta) onDelta({ delta, accumulated: next })
      return { accumulated: next, streamDone: !!chunk.choices?.[0]?.finish_reason }
    } catch (_) {
      return null
    }
  }
}

export { LLMClient }
