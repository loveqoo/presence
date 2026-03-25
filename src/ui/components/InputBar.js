import React, { useState, useRef } from 'react'
import { Box, Text, useInput } from 'ink'

const h = React.createElement

const MAX_HISTORY = 50

const InputBar = ({ onSubmit = () => {}, disabled = false, isActive = true, historyRef: externalHistoryRef }) => {
  // value + cursor를 단일 state로 관리하여 원자적 업데이트 보장.
  // 별도 state 시 빠른 입력(한글 IME)에서 cursor 클로저가 stale → 글자 순서 뒤바뀜.
  const [{ value, cursor }, setInput] = useState({ value: '', cursor: 0 })
  const internalHistoryRef = useRef([])
  const historyRef = externalHistoryRef || internalHistoryRef
  const indexRef = useRef(-1)
  const draftRef = useRef('')

  const setValueAndCursor = (text, pos) => {
    setInput({ value: text, cursor: pos != null ? pos : text.length })
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
      setInput(s => ({ ...s, cursor: Math.max(0, s.cursor - 1) }))
      return
    }

    // → 커서 오른쪽
    if (key.rightArrow) {
      setInput(s => ({ ...s, cursor: Math.min(s.value.length, s.cursor + 1) }))
      return
    }

    // Home / Ctrl+A
    if (key.ctrl && input === 'a') {
      setInput(s => ({ ...s, cursor: 0 }))
      return
    }

    // End / Ctrl+E
    if (key.ctrl && input === 'e') {
      setInput(s => ({ ...s, cursor: s.value.length }))
      return
    }

    if (key.backspace || key.delete) {
      setInput(s => s.cursor > 0
        ? { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 }
        : s
      )
      return
    }

    if (input && !key.ctrl && !key.meta) {
      setInput(s => ({
        value: s.value.slice(0, s.cursor) + input + s.value.slice(s.cursor),
        cursor: s.cursor + input.length,
      }))
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
