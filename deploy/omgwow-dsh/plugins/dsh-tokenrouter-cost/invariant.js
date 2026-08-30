/**
 * dsh-tokenrouter-cost 的 invariant 伴生：把「账本一致性」注册进官方的
 * `ctx.invariants` 运行时注册表（与 @deepseek-ai/dsh-invariants 契约一致）。
 *
 * 本插件拥有可断言的运行时关系：每一天的合计必须等于其 byModel 各行之和
 * （input/output/cacheRead/cacheWrite/calls/cost）。注册时立即复核存量账本；
 * 每次 llm/stream 结束且账本落盘（写去抖 1.5s）后再复核一次。
 */
export const name = 'tokenrouter-cost-invariant'

export const inject = ['invariants']

const PACKAGE_NAME = 'dsh-tokenrouter-cost'

/**
 * 注册账本一致性校验：安装器运行在 invariants 提供的子 fiber 中，
 * 违规经注册表的 fail 通道抛出 InvariantError（code INVARIANT，归属本包名）。
 * @param ctx - 携带 invariants 服务的 Cordis 上下文。
 * @returns 注册完成后的注销函数。
 */
export async function apply(ctx) {
  const install = async (invCtx, fail) => {
    const mod = await import('./index.js')
    const violations = mod.ledgerConsistencyViolations
    const runCheck = () => {
      for (const message of violations()) fail(message)
    }
    runCheck()
    invCtx.on('llm/stream', (_options, next) => {
      const downstream = next()
      return (async function* invariantStream() {
        try {
          for await (const chunk of downstream) yield chunk
        } finally {
          // 计费包装器在流结束的 finally 中入账，写账本另有 1.5s 去抖；
          // 延后复核确保检查的是落盘后的账本。
          const timer = setTimeout(() => {
            try {
              runCheck()
            } catch (error) {
              invCtx.logger?.error?.(String(error))
            }
          }, 1800)
          timer.unref?.()
        }
      })()
    }, { global: true })
  }
  return ctx.invariants.register(PACKAGE_NAME, install)
}
