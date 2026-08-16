/**
 * Pure Jupyter notebook (.ipynb) model: JSON parsing, cell addressing, and
 * generation helpers. No I/O — everything here is a function of its inputs, so
 * the replace/insert/delete round-trips and the cell-address edge cases are
 * directly unit-testable apart from the fs seam.
 *
 * Cell addressing matches Claude Code's NotebookEditTool: a `cell_id` addresses
 * a cell by its real `id` first; when no cell carries that id, the legacy
 * `cell-<index>` form addresses the cell at the zero-based `<index>` (the id a
 * cell without an `id` field is displayed as). See `parseCellId`.
 * @module
 */

/** One callable (code/markdown) notebook cell. */
export interface NotebookCell {
  cell_type: 'code' | 'markdown'
  id?: string
  source: string | string[]
  metadata: Record<string, unknown>
  execution_count?: number | null
  outputs?: unknown[]
}

/** A parsed Jupyter notebook (.ipynb) document. */
export interface NotebookContent {
  cells: NotebookCell[]
  metadata: { language_info?: { name?: string } }
  nbformat: number
  nbformat_minor: number
}

/**
 * Parse raw notebook text into the structural subset this tool edits, or
 * `null` when the text is not valid JSON or lacks a `cells` array. CC rejects a
 * non-JSON notebook with "Notebook is not valid JSON."; a malformed-but-JSON
 * body (missing `cells`) is treated as not a valid notebook for the same guard,
 * because there is no cell list to address.
 * @param content - the raw file text.
 * @returns the parsed notebook, or `null` when unparseable.
 */
export function parseNotebook(content: string): NotebookContent | null {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  const cells = body['cells']
  if (!Array.isArray(cells)) return null
  const metadata = body['metadata']
  const nbformat = Number(body['nbformat'])
  const nbformatMinor = Number(body['nbformat_minor'])
  return {
    cells: cells as NotebookCell[],
    metadata: metadata as NotebookContent['metadata'],
    nbformat,
    nbformat_minor: nbformatMinor,
  }
}

/**
 * Parse a `cell-<index>` cell reference into its zero-based index. Any other
 * form (including a bare numeric string, which is never a valid ipynb cell
 * identifier) yields `undefined`.
 * @param cellId - the cell identifier to parse.
 * @returns the zero-based index, or `undefined` when not a `cell-<n>` form.
 */
export function parseCellId(cellId: string): number | undefined {
  const match = /^cell-(\d+)$/.exec(cellId)
  if (match === null || match[1] === undefined) return undefined
  const index = Number.parseInt(match[1], 10)
  return Number.isNaN(index) ? undefined : index
}

/**
 * Resolve a `cell_id` to a cell position. CC matches the real `id` first, then
 * falls back to the legacy zero-based `cell-<index>` form. Returns the resolved
 * index and whether it was found, or -1 / false when the identifier addresses
 * no cell.
 * @param cells - the notebook's cell list.
 * @param cellId - the identifier to resolve.
 * @returns a found cell index, or `{ index: -1, found: false }`.
 */
export function findCellIndex(
  cells: readonly NotebookCell[],
  cellId: string,
): { index: number; found: boolean } {
  const byId = cells.findIndex(cell => cell.id === cellId)
  if (byId !== -1) return { index: byId, found: true }
  const parsed = parseCellId(cellId)
  if (parsed !== undefined && parsed < cells.length) {
    return { index: parsed, found: true }
  }
  return { index: -1, found: false }
}

/**
 * The notebook's programming language, defaulting to `python` when the metadata
 * does not name one — the same default CC uses in `NotebookEditTool.call()`.
 * @param notebook - the parsed notebook.
 * @returns the language_info name, or `'python'`.
 */
export function languageOf(notebook: NotebookContent): string {
  return notebook.metadata.language_info?.name ?? 'python'
}

/**
 * Whether this notebook's format version carries real cell ids (nbformat > 4,
 * or 4 with minor >= 5). Only such notebooks receive a freshly minted id on
 * insert / echo the target id on replace; older notebooks keep their ids as-is
 * (CC only sets the new id under this version gate).
 * @param notebook - the parsed notebook.
 * @returns whether the version supports labelled cell ids.
 */
export function supportsCellIds(notebook: NotebookContent): boolean {
  return (
    notebook.nbformat > 4 ||
    (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
  )
}

/**
 * Mint a fresh, collision-safe cell id: a base-36 string, matching CC's
 * `Math.random().toString(36).substring(2, 15)` id generator.
 * @returns a new cell id.
 */
export function newCellId(): string {
  return Math.random().toString(36).substring(2, 15)
}
