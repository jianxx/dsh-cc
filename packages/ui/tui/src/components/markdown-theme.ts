/**
 * Markdown theme built from the TUI's SGR helpers. Assistant rows pass through
 * the vendored Markdown component with this theme; syntax highlighting is added
 * in R2b via `highlightCode`.
 * @module @jianxx/dsh-cc-tui/components/markdown-theme
 */

import type { MarkdownTheme } from '@jianxx/dsh-cc-pi-tui'
import { bold, cyan, dim, italic, strikethrough, underline, yellow } from './theme.ts'

/** Sensible ANSI mapping for the vendored Markdown component. */
export function createMarkdownTheme(): MarkdownTheme {
  return {
    heading: bold,
    link: cyan,
    linkUrl: (text: string) => dim(underline(text)),
    code: yellow,
    codeBlock: yellow,
    codeBlockBorder: dim,
    quote: italic,
    quoteBorder: dim,
    hr: dim,
    listBullet: cyan,
    bold,
    italic,
    strikethrough,
    underline,
  }
}
