/**
 * Cache-hit-rate benchmark (Item 6): standard trajectory schema, deterministic
 * runner, report fold, and regression thresholds. Public API re-exports.
 * @module @jianxx/dsh-cc-cache-trajectory
 */

export {
  CACHE_E2E_MIN_HIT_RATE_ENV,
  cacheTrajectoryReportSchema,
  evaluateInvariants,
  foldRates,
  foldReport,
  hitRate,
  renderReportTable,
  thresholdsFromEnv,
  type CacheTrajectoryReport,
  type FoldedRates,
  type InvariantInput,
  type ReportInput,
  type RequestUsageRow,
  type Thresholds,
} from './report.ts'
export {
  loadStandardTrajectory,
  parseTrajectory,
  standardTrajectoryPath,
  trajectorySchema,
  trajectoryToolSchema,
  trajectoryTurnSchema,
  type CacheTrajectory,
} from './trajectory.ts'
export {
  runCacheTrajectory,
  type RunCacheTrajectoryOptions,
  type TrajectoryRunResult,
} from './runner.ts'
