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

  async chat({ messages, tools, responseFormat }) {
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
}

export { LLMClient }
