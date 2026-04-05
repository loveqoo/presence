import { TOGGLEABLE_ITEMS } from '../components/StatusBar.js'

// /statusline [+item|-item] command handler.

const cmdShow = (statusItems, addMessage) => {
  const visible = statusItems.join(', ')
  const available = TOGGLEABLE_ITEMS.filter(k => !statusItems.includes(k)).join(', ')
  addMessage({
    role: 'system',
    content: `statusline items: ${visible} (status: always on)\navailable: ${available || '(all shown)'}\nusage: /statusline +item  /statusline -item`,
  })
}

const cmdAdd = (item, statusItems, setStatusItems, addMessage) => {
  if (!TOGGLEABLE_ITEMS.includes(item)) { addMessage({ role: 'system', content: `unknown item: ${item}. available: ${TOGGLEABLE_ITEMS.join(', ')}` }); return }
  if (statusItems.includes(item)) { addMessage({ role: 'system', content: `${item} is already visible` }); return }
  setStatusItems(prev => [...prev, item])
  addMessage({ role: 'system', content: `+${item}` })
}

const cmdRemove = (item, statusItems, setStatusItems, addMessage) => {
  if (item === 'status') { addMessage({ role: 'system', content: 'status is always visible' }); return }
  if (!statusItems.includes(item)) { addMessage({ role: 'system', content: `${item} is not currently visible` }); return }
  setStatusItems(prev => prev.filter(i => i !== item))
  addMessage({ role: 'system', content: `-${item}` })
}

const handleStatusline = (input, ctx) => {
  const { statusItems, setStatusItems, addMessage } = ctx
  const arg = input.slice('/statusline'.length).trim()
  if (!arg) return cmdShow(statusItems, addMessage)
  if (arg.startsWith('+')) return cmdAdd(arg.slice(1), statusItems, setStatusItems, addMessage)
  if (arg.startsWith('-')) return cmdRemove(arg.slice(1), statusItems, setStatusItems, addMessage)
  addMessage({ role: 'system', content: `usage: /statusline  /statusline +item  /statusline -item` })
}

export { handleStatusline }
