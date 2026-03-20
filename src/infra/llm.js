class LLMClient {
  constructor({ baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o', apiKey, fetchFn } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.model = model
    this.apiKey = apiKey || process.env.OPENAI_API_KEY
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

    const res = await this._fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
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

    // tool_calls가 있으면 그대로 반환 (function calling)
    if (choice.message.tool_calls) {
      return { type: 'tool_calls', toolCalls: choice.message.tool_calls, raw: data }
    }

    return { type: 'text', content: choice.message.content, raw: data }
  }
}

export { LLMClient }
