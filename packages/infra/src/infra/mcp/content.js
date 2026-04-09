// MCP result → 텍스트 변환

const extractContent = (content) => {
  if (!Array.isArray(content) || content.length === 0) return ''
  const texts = content.filter(item => item.type === 'text').map(item => item.text)
  const nonText = content.filter(item => item.type !== 'text')
  const parts = []
  if (texts.length > 0) parts.push(texts.join('\n'))
  if (nonText.length > 0) {
    parts.push(`[${nonText.length}개 비텍스트 콘텐츠 생략 (${nonText.map(item => item.type).join(', ')})]`)
  }
  return parts.join('\n')
}

export { extractContent }
