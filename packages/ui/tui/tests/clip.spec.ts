import { describe, expect, it } from 'vitest'
import { clipTranscript } from '@jianxx/dsh-cc-tui/clip.ts'
import type { TranscriptRow } from '@jianxx/dsh-cc-tui/store.ts'

describe('clipTranscript', () => {
  it('keeps the tail of a tall status catalog so the composer still fits', () => {
    const catalog = Array.from({ length: 16 }, (_, i) => `  ${i + 1}. model-${i + 1}`).join('\n')
    const rows: TranscriptRow[] = [{ kind: 'status', text: catalog }]
    const clipped = clipTranscript(rows, 5)
    expect(clipped).toHaveLength(1)
    expect(clipped[0]?.kind).toBe('status')
    const text = clipped[0]?.kind === 'status' ? clipped[0].text : ''
    expect(text.split('\n')).toHaveLength(5)
    expect(text).toContain('12. model-12')
    expect(text).toContain('16. model-16')
    expect(text).not.toContain('1. model-1')
  })

  it('drops older rows before clipping the newest', () => {
    const rows: TranscriptRow[] = [
      { kind: 'user', text: 'old' },
      { kind: 'assistant', text: 'a\nb\nc' },
    ]
    const clipped = clipTranscript(rows, 2)
    expect(clipped).toEqual([{ kind: 'assistant', text: 'b\nc' }])
  })

  it('returns nothing when the budget is zero', () => {
    expect(clipTranscript([{ kind: 'user', text: 'hi' }], 0)).toEqual([])
  })
})
