import { describe, expect, it } from 'vitest'
import { renderDiffLines } from '@jianxx/dsh-cc-tui/components/diff-card.ts'
import type { FileDiff } from '@jianxx/dsh-cc-tui/tool-card.ts'

/** Strip SGR sequences for readability in assertions that check structure. */
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'

describe('renderDiffLines', () => {
  it('returns [] for an empty diffs array', () => {
    expect(renderDiffLines([])).toEqual([])
  })

  it('tags a new file with (new file)', () => {
    const diffs: FileDiff[] = [{ path: 'foo.ts', oldText: null, newText: 'hello\n' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines[0]).toBe('  foo.ts (new file)')
    expect(lines.some(l => l.includes('+ hello'))).toBe(true)
  })

  it('tags a deleted file with (deleted)', () => {
    const diffs: FileDiff[] = [{ path: 'bar.ts', oldText: 'content\n', newText: '' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines[0]).toBe('  bar.ts (deleted)')
    expect(lines.some(l => l.includes('- content'))).toBe(true)
  })

  it('omits a tag for an in-place edit', () => {
    const diffs: FileDiff[] = [{ path: 'baz.ts', oldText: 'a\n', newText: 'b\n' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines[0]).toBe('  baz.ts')
  })

  it('emits red removals and green additions with SGR codes', () => {
    const diffs: FileDiff[] = [{ path: 'f.ts', oldText: 'old\n', newText: 'new\n' }]
    const lines = renderDiffLines(diffs)
    const removed = lines.find(l => strip(l).includes('- old'))
    const added = lines.find(l => strip(l).includes('+ new'))
    expect(removed).toBeDefined()
    expect(added).toBeDefined()
    expect(removed!).toContain(RED)
    expect(added!).toContain(GREEN)
  })

  it('collapses common prefix and suffix, showing only the changed middle + context', () => {
    // 20 lines: lines 1-8 and 13-20 are unchanged; line 9 changes.
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    const newLines = oldLines.slice()
    newLines[8] = 'CHANGED'
    const diffs: FileDiff[] = [{
      path: 'big.ts',
      oldText: oldLines.join('\n') + '\n',
      newText: newLines.join('\n') + '\n',
    }]
    const lines = renderDiffLines(diffs).map(strip)
    // Header + context prefix (≤2) + 1 removal + 1 addition + context suffix (≤2)
    // = at most 7 lines, NOT 20+.
    expect(lines.length).toBeLessThanOrEqual(8)
    expect(lines[0]).toBe('  big.ts')
    // The changed line must appear.
    expect(lines.some(l => l.includes('- line 9'))).toBe(true)
    expect(lines.some(l => l.includes('+ CHANGED'))).toBe(true)
    // Unchanged middle lines far from the edit must NOT appear.
    expect(lines.some(l => l.includes('line 5'))).toBe(false)
    expect(lines.some(l => l.includes('line 15'))).toBe(false)
    // Context lines near the edit SHOULD appear (dimmed, leading space).
    expect(lines.some(l => l.startsWith('    line 7'))).toBe(true)
    expect(lines.some(l => l.startsWith('    line 11'))).toBe(true)
  })

  it('emits a single dim (no changes) line when old === new', () => {
    const diffs: FileDiff[] = [{ path: 'same.ts', oldText: 'a\nb\n', newText: 'a\nb\n' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines).toEqual(['  same.ts', '    (no changes)'])
  })

  it('caps total lines with a trailer when the diff is huge', () => {
    // 200 lines all different → 200 removals + 200 additions, well over the cap.
    const oldText = Array.from({ length: 200 }, (_, i) => `old ${i + 1}`).join('\n') + '\n'
    const newText = Array.from({ length: 200 }, (_, i) => `new ${i + 1}`).join('\n') + '\n'
    const diffs: FileDiff[] = [{ path: 'huge.ts', oldText, newText }]
    const lines = renderDiffLines(diffs)
    expect(lines.length).toBeLessThanOrEqual(62) // cap + header + trailer
    const last = strip(lines[lines.length - 1]!)
    expect(last).toMatch(/… \(\d+ more lines\)/)
  })

  it('handles multiple files in one diff array', () => {
    const diffs: FileDiff[] = [
      { path: 'a.ts', oldText: null, newText: 'x\n' },
      { path: 'b.ts', oldText: 'y\n', newText: 'z\n' },
    ]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines.some(l => l === '  a.ts (new file)')).toBe(true)
    expect(lines.some(l => l === '  b.ts')).toBe(true)
    expect(lines.some(l => l.includes('+ x'))).toBe(true)
    expect(lines.some(l => l.includes('- y'))).toBe(true)
    expect(lines.some(l => l.includes('+ z'))).toBe(true)
  })

  it('normalizes trailing newlines consistently', () => {
    // newText with no trailing newline should still split cleanly.
    const diffs: FileDiff[] = [{ path: 'f.ts', oldText: 'a\nb', newText: 'a\nC' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines.some(l => l.includes('- b'))).toBe(true)
    expect(lines.some(l => l.includes('+ C'))).toBe(true)
    // 'a' is common prefix, should not appear as a +/− line.
    expect(lines.some(l => l.startsWith('+ a'))).toBe(false)
    expect(lines.some(l => l.startsWith('- a'))).toBe(false)
  })
})
