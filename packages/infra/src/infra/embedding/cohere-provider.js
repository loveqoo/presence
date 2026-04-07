import { EmbeddingProvider } from './provider.js'

class CohereProvider extends EmbeddingProvider {
  constructor(opts) {
    super({
      ...opts,
      defaultBaseUrl: 'https://api.cohere.com/v2',
      defaultModel: 'embed-v4.0',
    })
  }

  get endpoint() { return '/embed' }

  buildBody(text) {
    return {
      texts: [text],
      model: this.model,
      input_type: 'search_query',
      embedding_types: ['float'],
    }
  }

  extractVector(data) { return data.embeddings.float[0] }
}

export { CohereProvider }
