// session-inspect.mjs — 读一个会话的 header + 完整事件日志(不激活 agent),按宿主形态选接口(2026-10-29,dsh 0.2.2-alpha.2)。
// 0.2.1:SessionController.inspect(sid, signal) → {meta, inheritedEventCount, events};找不到会话抛 ApiSessionNotFound
//   (message 'session "<id>" not found',类不导出)。
// 0.2.2:SessionController 删了 inspect;同样的读法是 sessionQuery.observeSession(sid, {projectionMode:"none"})(0.2.1 的 inspect
//   就是这么实现的:live 会话用内存快照,冷会话读盘),找不到时 SessionQueryError code SESSION_QUERY_SESSION_NOT_FOUND。
// 这里把后者换成与旧版同文案的 Error,调用方已有的 not-found 判定(dsh-alignment todos.js isSessionGone)不用改。
// 形态按「方法是否存在」判断,不看版本号;两种都没有就抛错(fail loud)。
// 唯一源在 ~/.dsh/lib;用到它的插件各带一份逐字节相同的副本(插件目录在 dsh-hmr 的 profileRoots 里,会随插件重载;
// ~/.dsh/lib 不会,插件 import lib 的新导出在重组时会因旧缓存被撤下)。副本清单与一致性守卫见 lib/session-inspect.test.mjs。
// 用法:const inspect = sessionInspector(() => ({ sessionController: ctx.sessionController, sessionQuery: ctx.get("sessionQuery") }));
//       const { meta, inheritedEventCount, events } = await inspect(sid, signal);

const NOT_FOUND_CODE = 'SESSION_QUERY_SESSION_NOT_FOUND';

/** The Error the 0.2.1 controller throws for a missing session (same message, so existing not-found checks keep working). */
export function sessionNotFound(sessionId) {
  return new Error('session "' + sessionId + '" not found');
}

/**
 * Build an inspect(sid, signal?) over whichever host API exists. services() is read on every call (services can be
 * re-provided after apply; sessionQuery is looked up, not injected).
 * @param {() => {sessionController?: object, sessionQuery?: object}} services
 */
export function sessionInspector(services) {
  return async function inspectSession(sessionId, signal) {
    const { sessionController, sessionQuery } = services();
    if (typeof sessionController?.inspect === 'function') return sessionController.inspect(sessionId, signal);
    if (typeof sessionQuery?.observeSession !== 'function') {
      throw new Error('session-inspect: neither sessionController.inspect (dsh <= 0.2.1) nor sessionQuery.observeSession (0.2.2+) is available');
    }
    let observation;
    try {
      observation = await sessionQuery.observeSession(sessionId, { ...(signal === undefined ? {} : { signal }), projectionMode: 'none' });
    } catch (error) {
      if (error?.code === NOT_FOUND_CODE) throw sessionNotFound(sessionId);
      throw error;
    }
    try {
      // the 0.2.1 controller also treats a header without cwd as not found (not a listed session)
      if (observation.header?.cwd === undefined) throw sessionNotFound(sessionId);
      if (!Array.isArray(observation.events) || typeof observation.inheritedEventCount !== 'number') {
        throw new Error('session-inspect: sessionQuery.observeSession returned no events[] / inheritedEventCount (dsh session-query changed shape)');
      }
      return { meta: observation.header, inheritedEventCount: observation.inheritedEventCount, events: [...observation.events] };
    } finally {
      observation[Symbol.dispose]?.();
    }
  };
}

/** Whether this host can inspect sessions at all (for apply-time fail-loud checks). */
export function canInspectSessions({ sessionController, sessionQuery }) {
  return typeof sessionController?.inspect === 'function' || typeof sessionQuery?.observeSession === 'function';
}
