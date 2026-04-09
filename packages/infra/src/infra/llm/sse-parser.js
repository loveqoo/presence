// SSE 프로토콜 파싱 — LLM 스트리밍 응답을 텍스트로 축적

class SseParser {
  // 스트리밍 미지원 시 일반 JSON 응답 처리
  async parse(response, onDelta) {
    if (!response.body || !response.body.getReader) {
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content ?? ''
      if (onDelta) onDelta({ delta: content, accumulated: content })
      return { type: 'text', content }
    }
    const content = await this.#drain(response.body.getReader(), onDelta)
    return { type: 'text', content }
  }

  // reader에서 chunk 읽어 줄 단위로 파싱. streamDone 감지 시 reader cancel.
  async #drain(reader, onDelta) {
    const decoder = new TextDecoder()
    let buffer = ''
    let accumulated = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      const result = this.#consumeLines(lines, accumulated, onDelta)
      accumulated = result.accumulated
      if (result.streamDone) { reader.cancel().catch(() => {}); break }
    }
    return accumulated
  }

  // 한 배치의 SSE 라인 소비. [DONE]이나 finish_reason이 나오면 streamDone.
  #consumeLines(lines, accumulated, onDelta) {
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') return { accumulated, streamDone: true }
      const parsed = this.#parseChunk(data, accumulated, onDelta)
      if (!parsed) continue
      accumulated = parsed.accumulated
      if (parsed.streamDone) return { accumulated, streamDone: true }
    }
    return { accumulated, streamDone: false }
  }

  // 한 SSE chunk 파싱: JSON decode → delta 추출 → onDelta 호출. JSON 에러는 스킵.
  #parseChunk(data, accumulated, onDelta) {
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

export { SseParser }
