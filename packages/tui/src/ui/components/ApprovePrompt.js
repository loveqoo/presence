import React from 'react'
import { Box, Text, useInput } from 'ink'
import { t } from '@presence/infra/i18n'

const h = React.createElement

// 설명 문자열 기반으로 위험도를 추정한다. 도구 이름과 인자 키워드를 모두 본다.
const HIGH_RISK_PATTERNS = [
  /\bshell[_ ]exec\b/i,
  /\brm\s+-/i,
  /\bfile[_ ](write|delete)\b/i,
  /\bsudo\b/i,
  /\bdelete\b/i,
  /\bDROP\s+TABLE\b/i,
]

const classifyRisk = (description) =>
  HIGH_RISK_PATTERNS.some((p) => p.test(description ?? '')) ? 'high' : 'normal'

const ApprovePrompt = ({ description, onResolve }) => {
  useInput((input) => {
    if (input === 'y' || input === 'Y') onResolve(true)
    if (input === 'n' || input === 'N') onResolve(false)
  })

  const risk = classifyRisk(description)
  const isHigh = risk === 'high'
  const label = isHigh ? t('approve.label_high') : t('approve.label_normal')
  const labelColor = isHigh ? 'red' : 'yellow'

  return h(
    Box,
    {
      flexDirection: 'column',
      paddingX: 1,
      borderStyle: isHigh ? 'double' : 'single',
      borderColor: isHigh ? 'red' : 'yellow',
    },
    h(
      Box,
      null,
      h(Text, { color: labelColor, bold: true }, label),
      h(Text, null, description),
    ),
    h(Text, { color: 'gray' }, `  [y] ${t('approve.approve')}  [n] ${t('approve.reject')}`),
  )
}

export { ApprovePrompt, classifyRisk }
