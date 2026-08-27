import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TuiAutocompleteProvider } from '@jianxx/dsh-cc-tui/components/completion.ts'
import type { CommandItem } from '@jianxx/dsh-cc-tui/components/completion.ts'

const COMMANDS: readonly CommandItem[] = [
  { name: 'model', description: 'pick adapter' },
  { name: 'quit', description: 'exit the tui' },
  { name: 'resume', description: 'list sessions', argumentHint: '<id>' },
]

describe('TuiAutocompleteProvider — slash commands', () => {
  const provider = new TuiAutocompleteProvider(COMMANDS, '/unused')

  it('prefix-filters slash commands by the text after /', async () => {
    const sig = new AbortController().signal
    const out = await provider.getSuggestions(['/mo'], 0, 3, { signal: sig })
    expect(out).not.toBeNull()
    const names = out!.items.map(i => i.value)
    expect(names).toContain('model')
    expect(names).not.toContain('quit')
  })

  it('returns all commands when the slash prefix is empty', async () => {
    const sig = new AbortController().signal
    const out = await provider.getSuggestions(['/'], 0, 1, { signal: sig })
    expect(out).not.toBeNull()
    expect(out!.items.map(i => i.value).sort()).toEqual(['model', 'quit', 'resume'])
  })

  it('returns null when no slash command matches', async () => {
    const sig = new AbortController().signal
    const out = await provider.getSuggestions(['/zzz'], 0, 4, { signal: sig })
    expect(out).toBeNull()
  })

  it('returns null for non-slash, non-@ input', async () => {
    const sig = new AbortController().signal
    const out = await provider.getSuggestions(['hello'], 0, 5, { signal: sig })
    expect(out).toBeNull()
  })

  it('returns null once a space follows the slash (argument territory)', async () => {
    const sig = new AbortController().signal
    const out = await provider.getSuggestions(['/model '], 0, 7, { signal: sig })
    expect(out).toBeNull()
  })

  it('applyCompletion replaces /partial with /name and a trailing space', () => {
    const item = { value: 'model', label: 'model' }
    const out = provider.applyCompletion(['/mo'], 0, 3, item, '/mo')
    expect(out.lines).toEqual(['/model '])
    expect(out.cursorLine).toBe(0)
    // cursor lands after "/model "
    expect(out.cursorCol).toBe('/model '.length)
  })

  it('applyCompletion preserves text after the cursor without doubling spaces', () => {
    const item = { value: 'quit', label: 'quit' }
    const out = provider.applyCompletion(['/qu tail'], 0, 3, item, '/qu')
    // The existing ' tail' is preserved; no extra separator is injected.
    expect(out.lines).toEqual(['/quit tail'])
    // Cursor lands right after the completed name, before the existing space.
    expect(out.cursorCol).toBe('/quit'.length)
  })
})

describe('TuiAutocompleteProvider — @ file completion (injected walk)', () => {
  // Directories carry a trailing '/' — matching defaultWalk's contract.
  const TREE = ['src/ten.js', 'src/text.js', 'src/deep/', 'src/deep/inner.ts', 'README.md']

  it('returns matching files for @src/te', async () => {
    const provider = new TuiAutocompleteProvider(COMMANDS, '/fake', () => TREE)
    const sig = new AbortController().signal
    const out = await provider.getSuggestions(['@src/te'], 0, 7, { signal: sig })
    expect(out).not.toBeNull()
    const labels = out!.items.map(i => i.label)
    expect(labels).toContain('ten.js')
    expect(labels).toContain('text.js')
    // Non-matching entries are filtered out.
    expect(labels).not.toContain('README.md')
  })

  it('sorts directories before files', async () => {
    const tree = ['src/a.ts', 'src/sub/', 'src/sub/b.ts', 'src/zzz.ts']
    const provider = new TuiAutocompleteProvider(COMMANDS, '/fake', () => tree)
    const sig = new AbortController().signal
    const out = await provider.getSuggestions(['@src/'], 0, 5, { signal: sig })
    expect(out).not.toBeNull()
    const first = out!.items[0]!
    // 'sub' is a directory → sorts first.
    expect(first.label.endsWith('/')).toBe(true)
  })

  it('applyCompletion for a file inserts @relpath + trailing space', () => {
    const provider = new TuiAutocompleteProvider(COMMANDS, '/fake', () => TREE)
    const item = { value: '@src/ten.js', label: 'ten.js' }
    const out = provider.applyCompletion(['@src/te'], 0, 7, item, '@src/te')
    expect(out.lines).toEqual(['@src/ten.js '])
    expect(out.cursorCol).toBe('@src/ten.js '.length)
  })

  it('applyCompletion for a directory keeps it open (no trailing space)', () => {
    const provider = new TuiAutocompleteProvider(COMMANDS, '/fake', () => TREE)
    const item = { value: '@src/deep/', label: 'deep/' }
    const out = provider.applyCompletion(['@src/de'], 0, 7, item, '@src/de')
    expect(out.lines).toEqual(['@src/deep/'])
    expect(out.cursorCol).toBe('@src/deep/'.length)
  })

  it('returns null when the walk yields no matches', async () => {
    const provider = new TuiAutocompleteProvider(COMMANDS, '/fake', () => TREE)
    const sig = new AbortController().signal
    const out = await provider.getSuggestions(['@nomatch'], 0, 8, { signal: sig })
    expect(out).toBeNull()
  })

  it('aborts mid-walk when the signal fires', async () => {
    let walkCalls = 0
    const provider = new TuiAutocompleteProvider(COMMANDS, '/fake', (_cwd, signal) => {
      walkCalls++
      if (signal.aborted) return []
      // simulate a long walk: abort right before reading results
      return TREE
    })
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await provider.getSuggestions(['@src/te'], 0, 7, { signal: ctrl.signal })
    expect(out).toBeNull()
    expect(walkCalls).toBeGreaterThanOrEqual(1)
  })

  it('honors the walk cap (200 results max)', async () => {
    const big: string[] = []
    for (let i = 0; i < 500; i++) big.push(`file${i}.ts`)
    const provider = new TuiAutocompleteProvider(COMMANDS, '/fake', () => big)
    const sig = new AbortController().signal
    const out = await provider.getSuggestions(['@file'], 0, 5, { signal: sig })
    expect(out).not.toBeNull()
    expect(out!.items.length).toBeLessThanOrEqual(200)
  })
})

describe('TuiAutocompleteProvider — default real-fs walk (smoke)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tui-completion-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'src', 'ten.js'), 'x')
    writeFileSync(join(dir, 'src', 'text.js'), 'x')
    writeFileSync(join(dir, 'node_modules', 'hidden.js'), 'x')
    writeFileSync(join(dir, '.git', 'config'), 'x')
  })

  afterEach(() => {
    // tmpdir is auto-cleaned by the OS; nothing to do.
  })

  it('walks the real cwd and skips .git / node_modules', async () => {
    const provider = new TuiAutocompleteProvider(COMMANDS, dir)
    const sig = new AbortController().signal
    const out = await provider.getSuggestions(['@src/te'], 0, 7, { signal: sig })
    expect(out).not.toBeNull()
    const labels = out!.items.map(i => i.label)
    expect(labels).toContain('ten.js')
    expect(labels).toContain('text.js')
    // node_modules and .git entries must not leak through.
    expect(out!.items.every(i => !i.value.includes('node_modules'))).toBe(true)
    expect(out!.items.every(i => !i.value.includes('.git'))).toBe(true)
  })
})
