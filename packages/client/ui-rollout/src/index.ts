/**
 * Web rollout plugin, node half.
 *
 * The host logic lives in @deepseek-ai/dsh-tokenrouter-rollout; this node
 * half exists so the bundle can mount the browser half (dsh.client row)
 * through the loader's dual-face convention.
 */

/** Host plugin body — everything host-side lives in the tokenrouter-rollout package. */
export function apply(): void {}
