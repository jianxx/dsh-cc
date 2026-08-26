/**
 * Tiny SGR (Select Graphic Rendition) helpers and a default editor theme.
 * No chalk — just raw ANSI codes embedded in Text content, which pi-tui's
 * Text component preserves through word-wrap.
 * @module @jianxx/dsh-cc-tui/components/theme
 */

import type { EditorTheme } from '@jianxx/dsh-cc-pi-tui'

/** Wrap text in an SGR sequence. */
export const sgr =
  (code: string) =>
  (text: string): string =>
    `\x1b[${code}m${text}\x1b[0m`

export const bold = sgr('1')
export const dim = sgr('2')
export const italic = sgr('3')
export const underline = sgr('4')
export const strikethrough = sgr('9')
export const cyan = sgr('36')
export const yellow = sgr('33')
export const red = sgr('31')
export const magenta = sgr('35')

/** Default editor theme: cyan border, dim descriptions. */
export const editorTheme: EditorTheme = {
  borderColor: cyan,
  selectList: {
    selectedPrefix: () => '> ',
    selectedText: cyan,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
}
