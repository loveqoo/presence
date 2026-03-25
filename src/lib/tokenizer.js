/**
 * Token Estimation Module
 *
 * 모델별 정확한 토크나이저 없이 문자 특성 기반으로 토큰 수를 추정한다.
 * 정확도보다 일관성과 비용 없는 추정이 목표.
 *
 * 근거:
 *   - 한글 음절 (AC00-D7A3): ~1.5 tokens/char (BPE 기반 토크나이저 공통)
 *   - CJK 한자 (4E00-9FFF): ~1 token/char
 *   - ASCII (00-7F): ~0.25 tokens/char (평균 4자 = 1토큰)
 *   - 기타 유니코드: ~1 token/char
 *   - 메시지 오버헤드: ~4 tokens (role, formatting)
 */

// 텍스트 → 추정 토큰 수
const estimateTokens = (text) => {
  if (!text) return 0
  let count = 0
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (code >= 0xAC00 && code <= 0xD7A3) count += 1.5       // 한글 음절
    else if (code >= 0x4E00 && code <= 0x9FFF) count += 1     // CJK 한자
    else if (code > 0xFF) count += 1                           // 기타 유니코드
    else count += 0.25                                         // ASCII
  }
  return Math.ceil(count)
}

// 메시지 배열 → 추정 토큰 수
const measureMessages = (msgs) =>
  msgs.reduce((s, m) => s + estimateTokens(m.content || '') + 4, 0)

// chars → tokens 변환 (config 하위 호환용)
const charsToTokens = (chars) => Math.ceil(chars / 3)

export { estimateTokens, measureMessages, charsToTokens }
