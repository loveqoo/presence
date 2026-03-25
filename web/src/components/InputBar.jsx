import { useState, useCallback } from 'react'

function InputBar({ onSubmit, disabled }) {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  const handleSubmit = useCallback((e) => {
    e.preventDefault()
    const text = value.trim()
    if (!text || disabled) return
    setHistory(prev => [text, ...prev].slice(0, 50))
    setHistoryIndex(-1)
    onSubmit(text)
    setValue('')
  }, [value, disabled, onSubmit])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHistoryIndex(prev => {
        const next = Math.min(prev + 1, history.length - 1)
        if (history[next]) setValue(history[next])
        return next
      })
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHistoryIndex(prev => {
        if (prev <= 0) { setValue(''); return -1 }
        const next = prev - 1
        if (history[next]) setValue(history[next])
        return next
      })
    }
  }, [history])

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
