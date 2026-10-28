// Which identifiers one DSH session carries, for the header's copy chips.
//
// A session's DSH id is always its own; an ACP-bound session (Claude Code / Codex / Oh My Pi, imported
// or started through the adapter) additionally resumes a native agent session, whose id its transcript
// lives under. Two sources can know that pairing — the import state file the scanner keeps (one entry
// per native session, keyed `<kind>:<native>`) and the ACP sidecar's live bindings — so this module
// stays a pure lookup over both, and the host half supplies the maps.
//
// Plain JS with no imports: the plugin host and its tests both load it directly.

/**
 * The identifiers of one session.
 * @param {Record<string, { kind?: string, nativeSessionId?: string | null }> | undefined | null} imported
 *   Import state entries by DSH session id.
 * @param {Record<string, { kind?: string, nativeSessionId?: string | null }> | undefined | null} bindings
 *   Live ACP bindings by DSH session id.
 * @param {string} id The DSH session id.
 * @returns {{ sessionId: string | null, kind: string, nativeSessionId: string | null }}
 */
export function sessionIdentity(imported, bindings, id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) return { sessionId: null, kind: "dsh", nativeSessionId: null };
  const found = imported?.[id] ?? bindings?.[id];
  if (found === undefined) return { sessionId: id, kind: "dsh", nativeSessionId: null };
  const nativeSessionId = typeof found.nativeSessionId === "string" && found.nativeSessionId.length > 0 ? found.nativeSessionId : null;
  return { sessionId: id, kind: typeof found.kind === "string" && found.kind.length > 0 ? found.kind : "dsh", nativeSessionId };
}