/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tokenrouter-rollout`.
 * @module @deepseek-ai/dsh-tokenrouter-rollout/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tokenrouter-rollout'

/** Cordis companion plugin name. */
export const name = 'tokenrouter-rollout-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Runtime invariant: injected rollout plans are user-role messages appended
 * through `agent.inject` (which lands in the inbox and the session log), and
 * every durable record is a declared SessionEventMap member — the repository
 * invariant "model-visible means logged" holds by construction.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
