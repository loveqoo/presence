import { EMBEDDING } from '@presence/core/core/policies.js'

// Template Method 기반 임베딩 API 클라이언트
class EmbeddingProvider {
  #fetchFn
  #apiUrl
  #apiKey
  #model
  #timeoutMs

  constructor(opts) {
    const { fetchFn, baseUrl, defaultBaseUrl, apiKey, model, defaultModel, timeoutMs } = opts
    this.#fetchFn = fetchFn || globalThis.fetch
    this.#apiUrl = (baseUrl || defaultBaseUrl).replace(/\/+$/, '')
    this.#apiKey = apiKey
    this.#model = model || defaultModel
    this.#timeoutMs = timeoutMs || EMBEDDING.TIMEOUT_MS
  }

  get model() { return this.#model }

  buildBody(_text) { throw new Error('Not implemented: buildBody') }

  extractVector(_data) { throw new Error('Not implemented: extractVector') }

  get endpoint() { throw new Error('Not implemented: endpoint') }

  async embed(text) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (this.#apiKey) headers['Authorization'] = `Bearer ${this.#apiKey}`
      const response = await this.#fetchFn(`${this.#apiUrl}${this.endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.buildBody(text)),
        signal: controller.signal,
      })
      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        throw new Error(`Embedding API error ${response.status}: ${errText}`)
      }
      const data = await response.json()
      return this.extractVector(data)
    } finally {
      clearTimeout(timer)
    }
  }
}

export { EmbeddingProvider }
