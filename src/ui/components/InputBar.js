import React, { useState, useRef } from 'react'
import { Box, Text, useInput } from 'ink'

const h = React.createElement

const MAX_HISTORY = 50

const InputBar = ({ onSubmit = () => {}, disabled = false, isActive = true, historyRef: externalHistoryRef }) => {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const internalHistoryRef = useRef([])
  const historyRef = externalHistoryRef || internalHistoryRef
  const indexRef = useRef(-1)
  const draftRef = useRef('')

  const setValueAndCursor = (text, pos) => {
    setValue(text)
    setCursor(pos != null ? pos : text.length)
  }

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
        setValueAndCursor('', 0)
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
      setValueAndCursor(history[next])
      return
    }

    // ↓ 다음 히스토리 / 원래 입력 복원
    if (key.downArrow) {
      if (indexRef.current <= 0) {
        indexRef.current = -1
        setValueAndCursor(draftRef.current)
        return
      }
      indexRef.current--
      setValueAndCursor(historyRef.current[indexRef.current])
      return
    }

    // ← 커서 왼쪽
    if (key.leftArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }

    // → 커서 오른쪽
    if (key.rightArrow) {
      setCursor(c => Math.min(value.length, c + 1))
      return
    }

    // Home / Ctrl+A
    if (key.ctrl && input === 'a') {
      setCursor(0)
      return
    }

    // End / Ctrl+E
    if (key.ctrl && input === 'e') {
      setCursor(value.length)
      return
    }

    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue(v => v.slice(0, cursor - 1) + v.slice(cursor))
        setCursor(c => c - 1)
      }
      return
    }

    if (input && !key.ctrl && !key.meta) {
      setValue(v => v.slice(0, cursor) + input + v.slice(cursor))
      setCursor(c => c + input.length)
    }
  }, { isActive: isActive && !disabled })

  const promptColor = disabled ? 'gray' : 'cyan'
  const before = value.slice(0, cursor)
  const cursorChar = value[cursor] || ' '
  const after = value.slice(cursor + 1)

  return h(Box, { paddingX: 1 },
    h(Text, { color: promptColor }, '> '),
    h(Text, null, before),
    disabled ? null : h(Text, { inverse: true }, cursorChar),
    h(Text, null, after),
  )
}

export { InputBar }
