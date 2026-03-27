class LLMClient {
  constructor({ baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o', apiKey, fetchFn, timeoutMs = 120_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.model = model
    this.apiKey = apiKey || process.env.OPENAI_API_KEY
    this.timeoutMs = timeoutMs
    this._fetch = fetchFn || globalThis.fetch
    if (!this._fetch) {
      throw new Error('LLMClient: fetch not available. Provide fetchFn or use Node 18+.')
    }
  }

  async chat({ messages, tools, responseFormat, signal }) {
    const body = {
      model: this.model,
      messages,
    }
    if (responseFormat) {
      body.response_format = responseFormat
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({ type: 'function', function: t }))
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })

    try {
      const res = await this._fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`LLM API error ${res.status}: ${text}`)
      }

      const data = await res.json()
      const choice = data.choices?.[0]
      if (!choice) {
        throw new Error('LLM API: no choices in response')
      }
      if (!choice.message) {
        throw new Error('LLM API: choice has no message')
      }

      if (choice.message.tool_calls) {
        return { type: 'tool_calls', toolCalls: choice.message.tool_calls, raw: data }
      }

      return { type: 'text', content: choice.message.content ?? '', raw: data }
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * SSE 스트리밍 방식으로 LLM 호출.
   * onDelta({ delta, accumulated })가 토큰 단위로 호출된다.
   * 반환값은 chat()과 동일: { type: 'text', content }
   */
  async chatStream({ messages, responseFormat, onDelta, signal }) {
    const body = {
      model: this.model,
      messages,
      stream: true,
    }
    if (responseFormat) {
      body.response_format = responseFormat
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })

    try {
      const res = await this._fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`LLM API error ${res.status}: ${text}`)
      }

      // 서버가 스트리밍을 지원하지 않으면 일반 JSON 응답 처리
      if (!res.body || !res.body.getReader) {
        const data = await res.json()
        const content = data.choices?.[0]?.message?.content ?? ''
        if (onDelta) onDelta({ delta: content, accumulated: content })
        return { type: 'text', content }
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulated = ''
      let streamDone = false

      while (!streamDone) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') { streamDone = true; break }

          try {
            const chunk = JSON.parse(data)
            const delta = chunk.choices?.[0]?.delta?.content
            if (delta) {
              accumulated += delta
              if (onDelta) onDelta({ delta, accumulated })
            }
            // finish_reason이 'stop'이면 스트림 완료
            if (chunk.choices?.[0]?.finish_reason) { streamDone = true; break }
          } catch (_) {}
        }
      }

      // 스트림 정리
      if (streamDone) reader.cancel().catch(() => {})

      return { type: 'text', content: accumulated }
    } finally {
      clearTimeout(timeout)
    }
  }
  setModel(model) {
    this.model = model
  }

  async listModels() {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`
      const res = await this._fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      if (!res.ok) return []
      const data = await res.json()
      return (data.data || []).map(m => m.id).sort()
    } catch (_) {
      return []
    } finally {
      clearTimeout(timeout)
    }
  }
}

export { LLMClient }
