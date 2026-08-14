/**
 * Package-owned invariant companion.
 *
 * No runtime invariant: this backend intentionally declares no custom
 * session-event types — this harness release refuses to persist or index
 * logs containing out-of-tree event types (there is no `ignorable` writing
 * surface yet), so all durable facts ride on the upstream `compaction/*`
 * bracket, whose relations are enforced by the
 * `@deepseek-ai/dsh-compaction/invariant` companion. The nudge and restore
 * user messages are core `user/message` events with plugin sources, and
 * their relations are enforced at the owning engine.
 *
 * @module dsh-asc/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-asc'

/** Cordis companion plugin name. */
export const name = 'dsh-asc-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package exposes no independent event sequence
 * or mutable data relation beyond contracts enforced at its owning seam.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
