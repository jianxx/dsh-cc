/**
 * Driver-backed slash argument completers injected into the TUI autocomplete
 * provider. `/model` completes from the live model catalog in both forms the
 * arg path accepts (`provider/id`, plus a bare `id` when unique across the
 * catalog — mirroring parseModelChoice); `/resume` completes session short ids.
 * Candidates are fetched per completion request, so catalog/session staleness
 * is bounded by the driver calls themselves.
 * @module @jianxx/dsh-cc-tui/components/arg-completers
 */

import type { AutocompleteItem } from '@jianxx/dsh-cc-pi-tui'
import type { ArgCompleterMap } from './completion.ts'
import type { Driver } from '../state/driver-types.ts'
import { shortenSession } from '../statusline.ts'

/** The slice of the driver the completers need (structural, easy to fake). */
export type ArgCompleterDriver = Pick<Driver, 'loadModelCatalog' | 'listSessions'>

/**
 * Build the per-command argument completer map handed to
 * {@link TuiAutocompleteProvider}. Only commands with meaningful arguments are
 * registered; every other slash command stays at the provider's null fallback.
 */
export function buildArgCompleters(driver: ArgCompleterDriver): ArgCompleterMap {
  return {
    model: async () => {
      const catalog = await driver.loadModelCatalog()
      // A bare id is only offered when it resolves unambiguously —
      // parseModelChoice rejects an id shared by multiple providers.
      const idCounts = new Map<string, number>()
      for (const entry of catalog) idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1)
      const items: AutocompleteItem[] = []
      for (const entry of catalog) {
        const key = `${entry.provider}/${entry.id}`
        items.push({
          value: key,
          label: key,
          ...entry.name.length === 0 ? {} : { description: entry.name },
        })
        if (idCounts.get(entry.id) === 1) {
          items.push({
            value: entry.id,
            label: entry.id,
            ...entry.name.length === 0 ? {} : { description: entry.name },
          })
        }
      }
      return items
    },
    resume: async () => {
      const sessions = await driver.listSessions()
      // Newest first, mirroring the /resume switcher overlay ordering.
      const sorted = sessions.slice().sort((a, b) => b.createdAt - a.createdAt)
      return sorted.map(session => {
        const short = shortenSession(session.id)
        return {
          value: short,
          label: short,
          ...short === session.id ? {} : { description: session.id },
        }
      })
    },
  }
}
