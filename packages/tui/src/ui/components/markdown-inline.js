// --- Inline parsing: **bold**, *italic*, _italic_, `code`, [link](url) ---
// 중첩 emphasis 미지원 — flat 토큰만 처리

const INLINE_REGEX = /(\*\*(.+?)\*\*|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!\w)_(.+?)_(?!\w)|`(.+?)`)/g

// [text](url) 링크를 탐지하여 { start, end, linkText } 배열 반환
const scanLinks = (text) => {
  const ranges = []
  for (let scanIdx = 0; scanIdx < text.length; scanIdx++) {
    if (text[scanIdx] !== '[') continue
    const closeBracket = text.indexOf(']', scanIdx + 1)
    if (closeBracket < 0 || text[closeBracket + 1] !== '(') continue
    const linkText = text.slice(scanIdx + 1, closeBracket)
    let depth = 1
    let urlEnd = closeBracket + 2
    while (urlEnd < text.length && depth > 0) {
      if (text[urlEnd] === '(') depth++
      else if (text[urlEnd] === ')') depth--
      urlEnd++
    }
    if (depth !== 0) continue
    ranges.push({ start: scanIdx, end: urlEnd, linkText })
    scanIdx = urlEnd - 1
  }
  return ranges
}

// regex 캡처 그룹 → inline part 변환
const classifyMatch = (match) => {
  if (match[2] != null) return { text: match[2], bold: true }
  if (match[3] != null) return { text: match[3], dimColor: true }
  if (match[4] != null) return { text: match[4], dimColor: true }
  if (match[5] != null) return { text: match[5], color: 'cyan' }
  return null
}

export const parseInline = (text) => {
  if (!text) return [{ text: '' }]
  const parts = []
  let lastIndex = 0

  const linkRanges = scanLinks(text)
  const isInLink = (pos) => linkRanges.some(range => pos >= range.start && pos < range.end)

  // 링크와 인라인을 병합 스캔
  let linkIdx = 0
  let match
  INLINE_REGEX.lastIndex = 0

  while (true) {
    match = INLINE_REGEX.exec(text)
    const nextLink = linkIdx < linkRanges.length ? linkRanges[linkIdx] : null
    if (!match && !nextLink) break

    // 링크가 먼저 나오면 링크 처리
    if (nextLink && (!match || nextLink.start < match.index)) {
      if (nextLink.start > lastIndex) parts.push({ text: text.slice(lastIndex, nextLink.start) })
      parts.push({ text: nextLink.linkText, color: 'blue' })
      lastIndex = nextLink.end
      linkIdx++
      INLINE_REGEX.lastIndex = lastIndex
      continue
    }

    // 인라인 매치가 링크 범위 안이면 무시
    if (match && isInLink(match.index)) continue

    // 인라인 매치 처리
    if (match) {
      if (match.index > lastIndex) parts.push({ text: text.slice(lastIndex, match.index) })
      const part = classifyMatch(match)
      if (part) parts.push(part)
      lastIndex = match.index + match[0].length
    }
  }

  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex) })
  return parts.length > 0 ? parts : [{ text: text || '' }]
}
