import { TOGGLEABLE_ITEMS } from '../components/StatusBar.js'
import { t } from '@presence/infra/i18n'

// /statusline [+item|-item] command handler.

const formatItem = (key) => {
  const label = t(`statusline_cmd.label.${key}`)
  // i18n 키가 없으면 원 키 그대로 반환 (방어)
  return label && label !== `statusline_cmd.label.${key}` ? `${key} — ${label}` : key
}

const formatConfig = (items) => {
  const visibleLines = items.map(k => `  ${formatItem(k)}`).join('\n')
  const availableLines = TOGGLEABLE_ITEMS.filter(k => !items.includes(k)).map(k => `  ${formatItem(k)}`).join('\n')
  return `현재 표시:\n${visibleLines}\n비활성:\n${availableLines || '  (모두 표시 중)'}`
}

const cmdShow = (statusItems, addMessage) => {
  addMessage({
    role: 'system',
    content: `${formatConfig(statusItems)}\n사용법: /statusline +항목  /statusline -항목`,
    transient: true,
  })
}

const cmdAdd = (item, statusItems, setStatusItems, addMessage) => {
  if (!TOGGLEABLE_ITEMS.includes(item)) { addMessage({ role: 'system', content: `알 수 없는 항목: ${item}\n가능: ${TOGGLEABLE_ITEMS.join(', ')}` }); return }
  if (statusItems.includes(item)) { addMessage({ role: 'system', content: `${item}: 이미 표시 중` }); return }
  const next = [...statusItems, item]
  setStatusItems(next)
  addMessage({ role: 'system', content: `+${item}\n${formatConfig(next)}`, transient: true })
}

const cmdRemove = (item, statusItems, setStatusItems, addMessage) => {
  if (item === 'status') { addMessage({ role: 'system', content: 'status 는 항상 표시됩니다' }); return }
  if (!statusItems.includes(item)) { addMessage({ role: 'system', content: `${item}: 표시 중이 아님` }); return }
  const next = statusItems.filter(i => i !== item)
  setStatusItems(next)
  addMessage({ role: 'system', content: `-${item}\n${formatConfig(next)}`, transient: true })
}

const handleStatusline = (input, ctx) => {
  const { statusItems, setStatusItems, addMessage } = ctx
  const arg = input.slice('/statusline'.length).trim()
  if (!arg) return cmdShow(statusItems, addMessage)
  if (arg.startsWith('+')) return cmdAdd(arg.slice(1), statusItems, setStatusItems, addMessage)
  if (arg.startsWith('-')) return cmdRemove(arg.slice(1), statusItems, setStatusItems, addMessage)
  addMessage({ role: 'system', content: `사용법: /statusline  /statusline +항목  /statusline -항목` })
}

export { handleStatusline }
