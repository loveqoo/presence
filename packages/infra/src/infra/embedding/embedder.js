import fp from '@presence/core/lib/fun-fp.js'
import { OpenAIProvider } from './openai-provider.js'
import { CohereProvider } from './cohere-provider.js'

const { Reader } = fp

const PROVIDER_CLASSES = Object.freeze({
  openai: OpenAIProvider,
  cohere: CohereProvider,
})

const createEmbedderR = Reader.asks(({ provider = 'openai', embedFn, ...opts }) => {
  if (embedFn) {
    return { embed: embedFn, model: opts.model || 'custom', dimensions: opts.dimensions || null }
  }

  const ProviderClass = PROVIDER_CLASSES[provider]
  if (!ProviderClass) {
    throw new Error(`Unknown embedding provider: ${provider}`)
  }

  const instance = new ProviderClass(opts)
  return {
    embed: (text) => instance.embed(text),
    model: instance.model,
    dimensions: opts.dimensions || null,
  }
})

// 레거시 브릿지
const createEmbedder = (opts) => createEmbedderR.run(opts)

export { createEmbedderR, createEmbedder }
