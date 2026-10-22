// Item 2 data-level check: the header's copy chips must offer the native agent session id exactly when
// the session is ACP-bound, and the DSH session id in every case. The lookup reads two sources — the
// import state the scanner keeps and the ACP sidecar's live bindings — so each source is exercised on
// its own, plus precedence between them, and plain DSH sessions must never grow a native id.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionIdentity } from "../identity.js";

test("an imported native session carries its kind and native session id", () => {
  const imported = { "session-1": { kind: "omp", nativeSessionId: "01a15e8d-16f3-7000-a658-6dfd20a634cd" } };
  assert.deepEqual(sessionIdentity(imported, {}, "session-1"), { sessionId: "session-1", kind: "omp", nativeSessionId: "01a15e8d-16f3-7000-a658-6dfd20a634cd" });
});

test("a live ACP binding supplies the native id before the next import pass records it", () => {
  const bindings = { "session-2": { kind: "codex", nativeSessionId: "01a15e1b-6acb-7000-9d23-3d592f8d1fd5" } };
  assert.deepEqual(sessionIdentity({}, bindings, "session-2"), { sessionId: "session-2", kind: "codex", nativeSessionId: "01a15e1b-6acb-7000-9d23-3d592f8d1fd5" });
});

test("the recorded import wins over a stale binding; a plain DSH session stays id-only", () => {
  const imported = { "session-3": { kind: "claude", nativeSessionId: "native-3" } };
  const bindings = { "session-3": { kind: "omp", nativeSessionId: "native-other" } };
  assert.deepEqual(sessionIdentity(imported, bindings, "session-3"), { sessionId: "session-3", kind: "claude", nativeSessionId: "native-3" });
  assert.deepEqual(sessionIdentity(imported, bindings, "session-9"), { sessionId: "session-9", kind: "dsh", nativeSessionId: null });
});

test("empty, missing and over-long ids never invent a native id", () => {
  const imported = { "": { kind: "omp", nativeSessionId: "native" } };
  const bindings = { "session-4": { kind: "omp", nativeSessionId: "native" } };
  for (const id of [undefined, "", "x".repeat(257)]) {
    assert.deepEqual(sessionIdentity(imported, bindings, id), { sessionId: null, kind: "dsh", nativeSessionId: null });
  }
  assert.deepEqual(sessionIdentity(undefined, undefined, "session-4"), { sessionId: "session-4", kind: "dsh", nativeSessionId: null });
  assert.deepEqual(sessionIdentity({ "session-4": { nativeSessionId: "native" } }, undefined, "session-4"), { sessionId: "session-4", kind: "dsh", nativeSessionId: "native" });
  assert.deepEqual(sessionIdentity({ "session-5": { kind: "omp" } }, undefined, "session-5"), { sessionId: "session-5", kind: "omp", nativeSessionId: null });
});