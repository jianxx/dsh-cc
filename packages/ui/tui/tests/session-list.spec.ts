import { describe, expect, it } from 'vitest'
import {
  filterSessions,
  formatSessionRow,
  sortByActivity,
  type SessionListEntry,
} from '@jianxx/dsh-cc-tui/harness/session-list.ts'

const entries = (...list: SessionListEntry[]): SessionListEntry[] => list

describe('sortByActivity', () => {
  it('sorts by updatedAtMs desc, falling back to createdAt when absent', () => {
    const list = entries(
      { id: 'a-old-active', createdAt: 100, updatedAtMs: 500 },
      { id: 'b-new-idle', createdAt: 900 },
      { id: 'c-mid-active', createdAt: 200, updatedAtMs: 700 },
    )
    expect(sortByActivity(list).map(e => e.id)).toEqual(['b-new-idle', 'c-mid-active', 'a-old-active'])
  })

  it('breaks activity ties by createdAt desc, then id', () => {
    const list = entries(
      { id: 'z-tie-old', createdAt: 100, updatedAtMs: 500 },
      { id: 'y-tie-mid', createdAt: 300, updatedAtMs: 500 },
      { id: 'x-tie-new', createdAt: 500, updatedAtMs: 500 },
      { id: 'w-tie-new', createdAt: 500 },
    )
    // Activity all 500 → createdAt desc puts the two 500s first; the
    // remaining tie breaks by id ('w' < 'x').
    expect(sortByActivity(list).map(e => e.id)).toEqual(['w-tie-new', 'x-tie-new', 'y-tie-mid', 'z-tie-old'])
  })

  it('returns a new list and does not mutate the input', () => {
    const list = entries({ id: 'b', createdAt: 2 }, { id: 'a', createdAt: 1 })
    const sorted = sortByActivity(list)
    expect(sorted).not.toBe(list)
    expect(list.map(e => e.id)).toEqual(['b', 'a'])
  })
})

describe('filterSessions', () => {
  const list = entries(
    { id: 'in-proj', cwd: '/proj', createdAt: 1, title: 'Fix picker bug' },
    { id: 'other-proj', cwd: '/other', createdAt: 2, title: 'Other thing' },
    { id: 'no-cwd', createdAt: 3 },
  )

  it('cwd scope keeps only same-project entries (cwd-less entries drop out)', () => {
    expect(filterSessions(list, { cwd: '/proj', scope: 'cwd', query: '' }).map(e => e.id))
      .toEqual(['in-proj'])
  })

  it('scope all keeps every entry including other projects and cwd-less ones', () => {
    expect(filterSessions(list, { cwd: '/proj', scope: 'all', query: '' }).map(e => e.id))
      .toEqual(['in-proj', 'other-proj', 'no-cwd'])
  })

  it('a missing or empty cwd keeps all entries even in cwd scope', () => {
    expect(filterSessions(list, { cwd: undefined, scope: 'cwd', query: '' })).toHaveLength(3)
    expect(filterSessions(list, { cwd: '', scope: 'cwd', query: '' })).toHaveLength(3)
  })

  it('query matches title, id, or cwd case-insensitively and trims whitespace', () => {
    expect(filterSessions(list, { cwd: undefined, scope: 'all', query: '  PICKER  ' }).map(e => e.id))
      .toEqual(['in-proj'])
    expect(filterSessions(list, { cwd: undefined, scope: 'all', query: 'IN-PROJ' }).map(e => e.id))
      .toEqual(['in-proj'])
    expect(filterSessions(list, { cwd: undefined, scope: 'all', query: '/other' }).map(e => e.id))
      .toEqual(['other-proj'])
  })

  it('a query with no match yields an empty list', () => {
    expect(filterSessions(list, { cwd: undefined, scope: 'all', query: 'zzz' })).toEqual([])
  })

  it('applies scope first, then the query', () => {
    expect(filterSessions(list, { cwd: '/proj', scope: 'cwd', query: 'other' })).toEqual([])
  })

  it('does not re-sort the filtered list', () => {
    const unsorted = entries(
      { id: 'c', createdAt: 3, title: 'same' },
      { id: 'a', createdAt: 1, title: 'same' },
      { id: 'b', createdAt: 2, title: 'same' },
    )
    expect(filterSessions(unsorted, { cwd: undefined, scope: 'all', query: 'same' }).map(e => e.id))
      .toEqual(['c', 'a', 'b'])
  })
})

describe('formatSessionRow', () => {
  const now = 10 * 24 * 60 * 60 * 1000

  it('uses updatedAtMs for the relative time and falls back to createdAt', () => {
    const active = formatSessionRow(
      { id: 'session-a', createdAt: now - 60 * 60 * 1000, updatedAtMs: now - 30 * 1000 },
      { now, currentId: 'other', showCwd: false },
    )
    expect(active.time).toBe('just now')
    const idle = formatSessionRow(
      { id: 'session-b', createdAt: now - 60 * 60 * 1000 },
      { now, currentId: 'other', showCwd: false },
    )
    expect(idle.time).toBe('1h ago')
  })

  it('labels with the title when present, else the 8-char short id', () => {
    const titled = formatSessionRow(
      { id: 'abcdefghij', createdAt: now, title: 'Fix picker bug' },
      { now, currentId: 'other', showCwd: false },
    )
    expect(titled.label).toBe('Fix picker bug')
    expect(titled.shortId).toBe('abcdefgh')
    const untitled = formatSessionRow(
      { id: 'abcdefghij', createdAt: now },
      { now, currentId: 'other', showCwd: false },
    )
    expect(untitled.label).toBe('abcdefgh')
  })

  it('marks the current session', () => {
    const row = formatSessionRow(
      { id: 'me', createdAt: now },
      { now, currentId: 'me', showCwd: false },
    )
    expect(row.current).toBe(true)
  })

  it('includes the cwd basename only when showCwd is set (posix and windows separators)', () => {
    const entry: SessionListEntry = { id: 'a', createdAt: now, cwd: '/home/u/proj' }
    expect(formatSessionRow(entry, { now, currentId: 'a', showCwd: true }).cwdPart).toBe('proj')
    expect(formatSessionRow(entry, { now, currentId: 'a', showCwd: false }).cwdPart).toBeUndefined()
    const win: SessionListEntry = { id: 'a', createdAt: now, cwd: 'C:\\Users\\u\\proj' }
    expect(formatSessionRow(win, { now, currentId: 'a', showCwd: true }).cwdPart).toBe('proj')
  })
})
