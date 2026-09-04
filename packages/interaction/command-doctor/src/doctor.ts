/**
 * Public `/doctor` report surface: the structured types and the text
 * formatter, so `@jianxx/dsh-cc-command-doctor/doctor` keeps resolving.
 * @module @jianxx/dsh-cc-command-doctor/doctor
 */

export { formatDoctorReport, type RenderOptions } from './render.ts'
export type {
  Check,
  CheckGroup,
  CheckStatus,
  DoctorReport,
} from './report.ts'
