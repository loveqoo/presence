import { LLM } from '@presence/core/core/policies.js'

// SSE 프로토콜 파싱 — LLM 스트리밍 응답을 텍스트로 축적

class SseParser {
  // 스트리밍 미지원 시 일반 JSON 응답 처리
  async parse(response, onDelta) {
    if (!response.body || !response.body.getReader) {
      const data = await response.json()
      const choice = data.choices?.[0]
      const content = choice?.message?.content ?? ''
      const truncated = choice?.finish_reason === LLM.FINISH_REASON.LENGTH
      if (onDelta) onDelta({ delta: content, accumulated: content })
      return { type: 'text', content, truncated }
    }
    const result = await this.#drain(response.body.getReader(), onDelta)
    return { type: 'text', content: result.content, truncated: result.truncated }
  }

  // reader에서 chunk 읽어 줄 단위로 파싱. streamDone 감지 시 reader cancel.
  async #drain(reader, onDelta) {
    const decoder = new TextDecoder()
    let buffer = ''
    let accumulated = ''
    let truncated = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      const result = this.#consumeLines(lines, accumulated, onDelta)
      accumulated = result.accumulated
      if (result.truncated) truncated = true
      if (result.streamDone) { reader.cancel().catch(() => {}); break }
    }
    return { content: accumulated, truncated }
  }

  // 한 배치의 SSE 라인 소비. [DONE]이나 finish_reason이 나오면 streamDone.
  #consumeLines(lines, accumulated, onDelta) {
    let truncated = false
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') return { accumulated, streamDone: true, truncated }
      const parsed = this.#parseChunk(data, accumulated, onDelta)
      if (!parsed) continue
      accumulated = parsed.accumulated
      if (parsed.truncated) truncated = true
      if (parsed.streamDone) return { accumulated, streamDone: true, truncated }
    }
    return { accumulated, streamDone: false, truncated }
  }

  // 한 SSE chunk 파싱: JSON decode → delta 추출 → onDelta 호출. JSON 에러는 스킵.
  // thinking 모델(qwen 등)은 delta.reasoning_content로 추론 토큰을 먼저 보낸 뒤 delta.content로 응답.
  // reasoning 토큰은 축적하지 않고 onDelta만 호출하여 UI 진행 표시.
  #parseChunk(data, accumulated, onDelta) {
    try {
      const chunk = JSON.parse(data)
      const choiceDelta = chunk.choices?.[0]?.delta
      const contentDelta = choiceDelta?.content
      const reasoningDelta = choiceDelta?.reasoning_content
      const finishReason = chunk.choices?.[0]?.finish_reason
      const truncated = finishReason === LLM.FINISH_REASON.LENGTH
      // content가 있으면 실제 응답 — 축적
      if (contentDelta) {
        const next = accumulated + contentDelta
        if (onDelta) onDelta({ delta: contentDelta, accumulated: next })
        return { accumulated: next, streamDone: !!finishReason, truncated }
      }
      // reasoning만 있으면 thinking 중 — 축적 없이 진행 알림만
      if (reasoningDelta && onDelta) {
        onDelta({ delta: '', accumulated, reasoning: reasoningDelta })
      }
      return { accumulated, streamDone: !!finishReason, truncated }
    } catch (_) {
      return null
    }
  }
}

export { SseParser }
