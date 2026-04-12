import { LLM } from '@presence/core/core/policies.js'

const extractModelId = (entry) => entry.id

// 모델 목록 조회 — LLMClient에서 분리
const listModelsFromApi = async (fetchFn, baseUrl, headers) => {
  const controller = new AbortController()
  const abortHandler = () => controller.abort()
  const timer = setTimeout(abortHandler, LLM.LIST_MODELS_TIMEOUT_MS)
  try {
    const response = await fetchFn(`${baseUrl}/models`, {
      method: 'GET', headers, signal: controller.signal,
    })
    if (!response.ok) return []
    const data = await response.json()
    return (data.data || []).map(extractModelId).sort()
  } catch (_) {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export { listModelsFromApi }
