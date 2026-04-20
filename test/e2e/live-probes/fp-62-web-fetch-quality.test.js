/**
 * FP-62 재현 probe — web_fetch 결과 품질 점검.
 *
 * 사용자가 "fsm에 대한 정의를 위키에서 찾아주시겠어요?" 를 묻으면 LLM 이
 * hallucination URL 로 Wikipedia 조회 → 비정상 HTML 반환.
 * 구현된 analyzeWebFetchResult 는 빈/짧은/disambiguation/missing 패턴 감지.
 * 라이브에서 실제 어떤 시그널이 관찰되는지 기록하고 향후 감지 로직 보강에 활용.
 *
 * 상태: open (2026-04-21 재현 확인). 감지 로직이 이 hallucination 케이스를
 * 놓치는 것을 확인 — HTML 파싱 기반 판단 필요.
 */
import { connect, probeTool } from '../live-helpers.js'
import { assert, summary } from '../../lib/assert.js'

const info = await connect()
console.log(`[probe FP-62] session=${info.sessionId} model=${info.config.llm?.model}`)

try {
  const result = await probeTool(info, {
    input: 'fsm에 대한 정의를 위키에서 찾아주시겠어요?',
    toolName: 'web_fetch',
  })

  console.log(`[probe FP-62] elapsed=${result.elapsed}ms status=${result.status}`)
  console.log(`[probe FP-62] web_fetch 호출 수: ${result.entries.length}`)

  // 이 probe 는 regression 보다 관찰을 위한 것. 구조만 고정하고 결과는 log.
  assert(result.status === 200 || result.status === 500,
    `FP-62: chat status 200 또는 500 (got ${result.status})`)
  assert(Array.isArray(result.entries),
    'FP-62: toolTranscript 에 web_fetch 호출 기록')

  for (const [i, entry] of result.entries.entries()) {
    const url = entry.args?.url || '(none)'
    const text = String(entry.result || '')
    const warningPrefix = text.startsWith('⚠')
    const likelyHallucinated = /\/wiki\/_/.test(url)   // 앞 underscore 패턴
    console.log(`[probe FP-62] web_fetch #${i + 1}:`)
    console.log(`  url=${url}`)
    console.log(`  warning prefix: ${warningPrefix}`)
    console.log(`  hallucination suspected: ${likelyHallucinated}`)
    console.log(`  result length: ${text.length}`)
    console.log(`  result preview: ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
  }

  summary()
} finally {
  await info.teardown()
}
