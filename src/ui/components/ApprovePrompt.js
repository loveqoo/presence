import React from 'react'
import { Box, Text, useInput } from 'ink'

const h = React.createElement

const ApprovePrompt = ({ description, onResolve }) => {
  useInput((input) => {
    if (input === 'y' || input === 'Y') onResolve(true)
    if (input === 'n' || input === 'N') onResolve(false)
  })

  return h(Box, { flexDirection: 'column', paddingX: 1 },
    h(Box, null,
      h(Text, { color: 'yellow', bold: true }, '⚠ APPROVE: '),
      h(Text, null, description),
    ),
    h(Text, { color: 'gray' }, '  [y] approve  [n] reject'),
  )
}

export { ApprovePrompt }
