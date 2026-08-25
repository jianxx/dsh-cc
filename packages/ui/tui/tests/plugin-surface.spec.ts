import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as tui from '@jianxx/dsh-cc-tui'

describe('@jianxx/dsh-cc-tui plugin surface', () => {
  it('exports a Loader-safe cordis plugin with agents inject', () => {
    expect(tui.name).toBe('dsh-cc-tui')
    expect(tui.inject).toEqual(['agents'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(tui)).toBe(tui)
  })
})
