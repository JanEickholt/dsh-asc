/**
 * TEMPORARY lane stub: the real signal derivation lands via the parallel
 * omos/analytics-signals lane and replaces this file wholesale at merge
 * time. Kept only so the command lane typechecks against the shared
 * contract.
 *
 * @module dsh-asc/analytics/signals
 */

import type { SignalOptions, SignalReport, UsageReport } from './types.ts'

/** Derive regret signals from a usage report. */
export function computeSignals(_report: UsageReport, _options?: SignalOptions): SignalReport {
  throw new Error('computeSignals not merged yet: the analytics-signals lane provides the real implementation')
}
