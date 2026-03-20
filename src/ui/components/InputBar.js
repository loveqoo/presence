import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

const h = React.createElement

const InputBar = ({ onSubmit = () => {}, placeholder = '' }) => {
  const [value, setValue] = useState('')

  useInput((input, key) => {
    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim())
        setValue('')
      }
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

  return h(Box, { borderStyle: 'single', borderTop: true, borderBottom: false, borderLeft: false, borderRight: false, paddingX: 1 },
    h(Text, { color: 'cyan' }, '> '),
    h(Text, null, value || placeholder),
    h(Text, { color: 'gray' }, '█'),
  )
}

export { InputBar }
