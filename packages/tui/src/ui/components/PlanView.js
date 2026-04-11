import React from 'react'
import { Box, Text } from 'ink'
import { t } from '@presence/infra/i18n'

const h = React.createElement

/**
 * Iteration/step 실행 과정을 인라인으로 시각화.
 *
 * steps: [{ op, args, status, result, error }]
 *   status: 'pending' | 'running' | 'done' | 'error' | 'approve'
 */

const STEP_ICONS = {
  pending: '○',
  running: '◐',
  done:    '✓',
  error:   '✗',
  approve: '⚠',
}

const STEP_COLORS = {
  pending: 'gray',
  running: 'yellow',
  done:    'green',
  error:   'red',
  approve: 'yellow',
}

const formatStepLabel = (step) => {
  const { op, args } = step
  if (op === 'EXEC') {
    const tool = args?.tool || '?'
    const toolArgs = args?.tool_args || {}
    const argSummary = Object.entries(toolArgs)
      .slice(0, 2)
      .map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 20)}`)
      .join(', ')
    return argSummary
      ? t('plan_op.exec', { tool, args: argSummary })
      : t('plan_op.exec_no_args', { tool })
  }
  if (op === 'ASK_LLM') return t('plan_op.ask_llm', { prompt: (args?.prompt || '').slice(0, 30) })
  if (op === 'RESPOND') return args?.ref ? t('plan_op.respond_ref', { ref: args.ref }) : t('plan_op.respond')
  if (op === 'APPROVE') return t('plan_op.approve', { description: args?.description || '?' })
  if (op === 'DELEGATE') return t('plan_op.delegate', { target: args?.target || '?' })
  if (op === 'LOOKUP_MEMORY') return t('plan_op.lookup_memory', { query: args?.query || '' })
  return op
}

const formatResult = (step) => {
  if (step.status === 'error') return step.error || 'error'
  if (step.status !== 'done' || step.result == null) return null
  const text = typeof step.result === 'string' ? step.result : JSON.stringify(step.result)
  return text.length > 40 ? text.slice(0, 40) + '…' : text
}

const StepLine = ({ step, isLast }) => {
  const icon = STEP_ICONS[step.status] || '?'
  const color = STEP_COLORS[step.status] || 'white'
  const connector = isLast ? '└─' : '├─'
  const result = formatResult(step)

  return h(Box, null,
    h(Text, { color: 'gray' }, `  ${connector} `),
    h(Text, { color }, `${icon} `),
    h(Text, null, formatStepLabel(step)),
    result ? h(Text, { color: 'gray' }, `  ${result}`) : null,
  )
}

const PlanView = ({ iteration, maxIterations, steps = [], status = 'running' }) => {
  const header = maxIterations
    ? `── iteration ${iteration + 1}/${maxIterations} `
    : `── iteration ${iteration + 1} `
  const headerPad = '─'.repeat(Math.max(0, 40 - header.length))

  return h(Box, { flexDirection: 'column' },
    h(Text, { color: status === 'error' ? 'red' : 'gray' }, `  ${header}${headerPad}`),
    ...steps.map((step, i) =>
      h(StepLine, { key: i, step, isLast: i === steps.length - 1 })
    ),
  )
}

export { PlanView, StepLine, formatStepLabel, formatResult }
