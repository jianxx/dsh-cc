/**
 * Ink view for the CC-mode TUI. Stock ink + react; no Ink fork.
 * @module @jianxx/dsh-cc-tui/ui
 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import type { Driver } from './harness/driver.ts'
import { parseSlash } from './slash.ts'
import type { TranscriptRow, TuiState } from './store.ts'

function renderRow(row: TranscriptRow, index: number): ReactNode {
  switch (row.kind) {
    case 'user':
      return <Text key={index} color="cyan">{`> ${row.text}`}</Text>
    case 'assistant':
      return <Text key={index}>{row.text}</Text>
    case 'thinking':
      return <Text key={index} dimColor italic>{row.text}</Text>
    case 'tool': {
      const status = row.running ? '…' : (row.error === true ? '✗' : '✓')
      const body = row.body ?? row.result ?? row.args
      return (
        <Text key={index} color={row.error === true ? 'red' : 'yellow'}>
          {`⏺ ${row.title} ${status}${body !== undefined && body.length > 0 ? `\n  ⎿ ${body.split('\n')[0]}` : ''}`}
        </Text>
      )
    }
    case 'status':
      return <Text key={index} dimColor>{row.text}</Text>
  }
}

export interface AppProps {
  driver: Driver
}

/**
 * Root Ink tree: transcript, overlays, composer, permission-mode footer.
 */
export function App({ driver }: AppProps): ReactElement {
  const [state, setState] = useState<TuiState>(driver.state)
  const { exit } = useApp()

  useEffect(() => driver.subscribe(setState), [driver])

  useInput((input, key) => {
    if (state.approval !== undefined) {
      if (input === '1' || input === 'y' || input === 'Y') driver.answerApproval(true)
      else if (input === '2' || input === 'n' || input === 'N' || key.escape) driver.answerApproval(false)
      return
    }
    if (state.question !== undefined) {
      const index = Number.parseInt(input, 10)
      const option = state.question.options[index - 1]
      if (option !== undefined) driver.answerQuestion(option)
      else if (key.escape) driver.answerQuestion(state.question.options[0] ?? '')
      return
    }
    if (key.tab && key.shift) {
      driver.cyclePermissionMode()
      return
    }
    if (key.escape) {
      if (state.busy) driver.interrupt()
      return
    }
    if (key.return) {
      const parsed = parseSlash(state.draft)
      void driver.submit().then(() => {
        if (parsed.kind === 'local' && (parsed.name === 'quit' || parsed.name === 'exit')) exit()
      })
      return
    }
    if (key.backspace || key.delete) {
      driver.setDraft(state.draft.slice(0, -1))
      return
    }
    if (input === 'c' && key.ctrl) {
      void driver.dispose().then(() => exit())
      return
    }
    if (input.length > 0 && !key.ctrl && !key.meta) {
      driver.setDraft(state.draft + input)
    }
  })

  return (
    <Box flexDirection="column">
      <Text bold>dsh cc-mode</Text>
      {state.rows.map(renderRow)}
      {state.notice === undefined ? null : <Text color="magenta">{state.notice}</Text>}
      {state.approval === undefined ? null : (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text>Approve {state.approval.toolName}?</Text>
          {state.approval.command === undefined ? null : <Text dimColor>{state.approval.command}</Text>}
          <Text>1 yes · 2 no</Text>
        </Box>
      )}
      {state.question === undefined ? null : (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text>{state.question.header}</Text>
          {state.question.options.map((option, index) => (
            <Text key={option}>{`${index + 1}. ${option}`}</Text>
          ))}
        </Box>
      )}
      <Text>{state.busy ? '◌ working…' : `❯ ${state.draft}`}</Text>
      <Text dimColor>{driver.statusLine}</Text>
    </Box>
  )
}
