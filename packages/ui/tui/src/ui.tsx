/**
 * Ink view for the CC-mode TUI. Stock ink + react; no Ink fork.
 * @module @jianxx/dsh-cc-tui/ui
 */

import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Box, Text, useInput, useApp, useStdout } from 'ink'
import type { Driver } from './harness/driver.ts'
import { clipTranscript } from './clip.ts'
import { handleComposerInput } from './input.ts'
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
  const { stdout } = useStdout()
  const rows = stdout?.rows ?? process.stdout.rows ?? 24
  // Title + composer + statusline, plus optional overlay chrome.
  const reserved = 3
    + (state.notice === undefined ? 0 : 1)
    + (state.approval === undefined ? 0 : 4)
    + (state.question === undefined ? 0 : 2 + state.question.options.length)
  const visibleRows = clipTranscript(state.rows, Math.max(1, rows - reserved))

  useEffect(() => driver.subscribe(setState), [driver])

  const onInput = useCallback((input: string, key: Parameters<typeof handleComposerInput>[2]) => {
    const action = handleComposerInput(driver, input, key)
    if (action.kind === 'quit') {
      exit()
      // Ink's exit() only unmounts; dsh's Loader keeps the process alive.
      // waitUntilExit in plugin.ts then process.exit(0).
    }
  }, [driver, exit])

  useInput(onInput)

  return (
    <Box flexDirection="column">
      <Text bold>dsh cc-mode</Text>
      {visibleRows.map(renderRow)}
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
