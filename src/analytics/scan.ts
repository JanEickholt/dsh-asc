/**
 * TEMPORARY lane stub: the real scanner lands via the parallel
 * omos/analytics-scan lane and replaces this file wholesale at merge time.
 * Kept only so the command lane typechecks against the shared contract.
 *
 * @module dsh-asc/analytics/scan
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { UsageReport } from './types.ts'

/** Scan one session's log into a usage report. */
export function scanSessionUsage(_session: Session): UsageReport {
  throw new Error('scanSessionUsage not merged yet: the analytics-scan lane provides the real implementation')
}
