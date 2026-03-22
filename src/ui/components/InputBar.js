import React, { useState, useRef } from 'react'
import { Box, Text, useInput } from 'ink'

const h = React.createElement

const MAX_HISTORY = 50

const InputBar = ({ onSubmit = () => {}, disabled = false }) => {
  const [value, setValue] = useState('')
  const historyRef = useRef([])
  const indexRef = useRef(-1)
  const draftRef = useRef('')

  useInput((input, key) => {
    if (disabled) return

    if (key.return) {
      if (value.trim()) {
        const text = value.trim()
        const history = historyRef.current
        if (history[0] !== text) {
          history.unshift(text)
          if (history.length > MAX_HISTORY) history.pop()
        }
        indexRef.current = -1
        draftRef.current = ''
        onSubmit(text)
        setValue('')
      }
      return
    }

    // ↑ 이전 히스토리
    if (key.upArrow) {
      const history = historyRef.current
      if (history.length === 0) return
      if (indexRef.current === -1) draftRef.current = value
      const next = Math.min(indexRef.current + 1, history.length - 1)
      indexRef.current = next
      setValue(history[next])
      return
    }

    // ↓ 다음 히스토리 / 원래 입력 복원
    if (key.downArrow) {
      if (indexRef.current <= 0) {
        indexRef.current = -1
        setValue(draftRef.current)
        return
      }
      indexRef.current--
      setValue(historyRef.current[indexRef.current])
      return
    }

    if (key.backspace || key.delete) {
      setValue(v => v.slice(0, -1))
      return
    }
    if (input && !key.ctrl && !key.meta) {
      setValue(v => v + input)
    }
  })

  const promptColor = disabled ? 'gray' : 'cyan'

  return h(Box, { paddingX: 1 },
    h(Text, { color: promptColor }, '> '),
    h(Text, null, value),
    disabled ? null : h(Text, { color: 'gray' }, '█'),
  )
}

export { InputBar }
