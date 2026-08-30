/**
 * The single source of truth for the `/permissions` rule-engine modes. Pure
 * and browser-safe (no cordis/session imports) so the host command (the write
 * path), the client popupSelect decoration (a pick submits `/permissions
 * <id>`), and the TUI picker overlay all render from the same lists and
 * cannot drift.
 */

/** The available CC rule-engine modes, shared by the switch list and the popup. */
export const PERMISSION_COMMAND_MODES = [
  'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions',
] as const
/** A union of the rule-engine mode ids. */
export type PermissionCommandMode = (typeof PERMISSION_COMMAND_MODES)[number]

/** One popup row: its switch id plus human-facing label and detail. */
export interface PermissionModeOption {
  readonly id: PermissionCommandMode
  readonly label: string
  readonly detail: string
}

/** The popup rows, in display order. */
export const PERMISSION_MODE_OPTIONS: readonly PermissionModeOption[] = [
  { id: 'default', label: 'Default', detail: 'Follow allow/deny/ask rules; unmatched calls pass through.' },
  { id: 'acceptEdits', label: 'Accept edits', detail: 'File edits are auto-allowed; other calls follow the rules.' },
  { id: 'plan', label: 'Plan', detail: 'Read-only until the plan is submitted via exit_plan_mode.' },
  { id: 'auto', label: 'Auto', detail: 'Low-risk approval prompts are auto-allowed; medium-risk prompts still ask.' },
  { id: 'bypassPermissions', label: 'Bypass permissions', detail: 'Skip permission prompts and pin the sandbox to full access. Bypass-immune and catastrophic commands stay denied.' },
]

/** The mode that carries the explicit risk gate (mirrors `/permission` Full access). */
export const BYPASS_MODE = 'bypassPermissions' as const

/**
 * Explicit risk gate on the bypassPermissions row, shared by the browser
 * popupSelect confirmation and the TUI picker overlay.
 */
export const BYPASS_CONFIRMATION = {
  title: 'Enable Bypass permissions?',
  description: 'Bypass permissions skips approval prompts and pins this session\'s sandbox to full access. Bypass-immune paths and catastrophic commands stay denied. Only use it when you trust the current task.',
  acknowledgeLabel: 'I understand the risks and want to continue',
  cancelLabel: 'Cancel',
  confirmLabel: 'Enable Bypass permissions',
} as const
