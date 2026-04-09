import { EmbeddingProvider } from './provider.js'

class OpenAIProvider extends EmbeddingProvider {
  #dimensions

  constructor(opts) {
    super({
      ...opts,
      defaultBaseUrl: 'https://api.openai.com/v1',
      defaultModel: 'text-embedding-3-small',
      apiKey: opts.apiKey || process.env.OPENAI_API_KEY || null,
    })
    this.#dimensions = opts.dimensions
  }

  get endpoint() { return '/embeddings' }

  buildBody(text) {
    const body = { input: text, model: this.model }
    if (this.#dimensions) body.dimensions = this.#dimensions
    return body
  }

  extractVector(data) { return data.data[0].embedding }
}

export { OpenAIProvider }
