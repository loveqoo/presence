import { useState, useCallback, useRef } from 'react'

function InputBar({ onSubmit, disabled }) {
  const [value, setValue] = useState('')
  const historyRef = useRef([])
  const indexRef = useRef(-1)

  const handleSubmit = useCallback((e) => {
    e.preventDefault()
    const text = value.trim()
    if (!text || disabled) return
    historyRef.current = [text, ...historyRef.current].slice(0, 50)
    indexRef.current = -1
    onSubmit(text)
    setValue('')
  }, [value, disabled, onSubmit])

  const handleKeyDown = useCallback((e) => {
    const history = historyRef.current
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.min(indexRef.current + 1, history.length - 1)
      if (history[next]) setValue(history[next])
      indexRef.current = next
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (indexRef.current <= 0) { setValue(''); indexRef.current = -1; return }
      const next = indexRef.current - 1
      if (history[next]) setValue(history[next])
      indexRef.current = next
    }
  }, [])

  return (
    <form className="input-bar" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? 'Thinking...' : 'Type a message...'}
        disabled={disabled}
        autoFocus
      />
      <button type="submit" disabled={disabled || !value.trim()}>Send</button>
    </form>
  )
}

export default InputBar
