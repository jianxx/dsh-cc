import { describe, expect, it } from 'vitest'
import { extractSelectedNames } from '../src/recall.ts'

describe('extractSelectedNames', () => {
  it('parses a bare JSON selected_memories array', () => {
    expect(extractSelectedNames('{"selected_memories": ["a.md", "b.md"]}')).toEqual(['a.md', 'b.md'])
  })

  it('parses an array wrapped in prose and code fences', () => {
    const text = 'Here are the matches:\n```json\n{"selected_memories":["a.md"]}\n```\n'
    expect(extractSelectedNames(text)).toEqual(['a.md'])
  })

  it('returns an empty array for an empty selection', () => {
    expect(extractSelectedNames('{"selected_memories": []}')).toEqual([])
  })

  it('drops non-string entries from the array', () => {
    expect(extractSelectedNames('{"selected_memories": ["a.md", 3, {"x":1}]}')).toEqual(['a.md'])
  })

  it('returns an empty array when the key is absent or unparseable', () => {
    expect(extractSelectedNames('{"other": []}')).toEqual([])
    expect(extractSelectedNames('no json here')).toEqual([])
    expect(extractSelectedNames('{"selected_memories": not-json}')).toEqual([])
  })
})
