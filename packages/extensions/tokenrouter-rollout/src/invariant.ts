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
 * No runtime invariant: rollout plans reach the model only through
 * `agent.inject`, whose own package already logs the appended user message, so
 * this package owns no cordis event stream and no cross-plugin mutable
 * relation of its own. Plan derivation and command dispatch are pure functions
 * asserted directly by this package's behavior specs.
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
