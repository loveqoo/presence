import { t } from '@presence/infra/i18n'

// Prompt tab: 마지막 LLM 요청 메시지들을 role별 색상으로 표시.

const add = (lines, text, color) => { lines.push({ text, color: color || null }); return lines }
const blank = (lines) => add(lines, '')

const roleColorOf = (role) => {
  if (role === 'system') return 'yellow'
  if (role === 'user') return 'white'
  return 'green'
}

const buildPromptLines = (lastPrompt) => {
  const lines = []
  if (!lastPrompt || lastPrompt.length === 0) { add(lines, t('transcript.no_prompt_data'), 'gray'); return lines }

  const totalChars = lastPrompt.reduce((s, m) => s + (m.content?.length || 0), 0)
  add(lines, `${lastPrompt.length} messages, ${totalChars} chars`, 'cyan')
  blank(lines)

  for (let i = 0; i < lastPrompt.length; i++) {
    const m = lastPrompt[i]
    const body = m.content || ''
    add(lines, `[${i}] ${m.role} (${body.length} chars)`, roleColorOf(m.role))
    for (const line of body.split('\n')) add(lines, `  ${line}`)
    blank(lines)
  }
  return lines
}

export { buildPromptLines }
