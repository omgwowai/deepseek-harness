// Test fixture: a minimal collector speaking the fleet protocol over this process's stdio, as `kubectl exec -i` or
// `ssh host agent-fleet collector --stdio` would run it. Flags: --host-id ID, --site SITE, --agent-id ID, --die-after MS.
import { parseArgs } from "node:util";
import { createChannel, stdioTransport } from "../../../lib/channel.mjs";
import { PROTOCOL_VERSION, agentKey } from "../../../lib/protocol.mjs";

const { values } = parseArgs({ options: { "host-id": { type: "string" }, site: { type: "string" }, "agent-id": { type: "string" }, "die-after": { type: "string" } } });
const hostId = values["host-id"] ?? "fixture", site = values.site ?? "mac";
const channel = createChannel({
  ...stdioTransport(),
  label: "fixture collector",
  onRequest: (method, params) => {
    if (method === "file.read") return { exists: true, size: 5, content: `from ${hostId}:${params.path}` };
    if (method === "ping") return { at: Date.now() };
    throw new Error(`unsupported ${method}`);
  },
  onClose: () => process.exit(0),
});
channel.send({ t: "hello", proto: PROTOCOL_VERSION, at: Date.now(), host: { id: hostId, site, kind: "server", label: hostId, hostname: hostId, platform: process.platform, roots: { dsh: [], claude: [], codex: [], omp: [] } } });
if (values["agent-id"]) {
  const now = Date.now();
  channel.send({
    t: "agent",
    agent: {
      key: agentKey(hostId, "omp", values["agent-id"]), host: hostId, site, kind: "omp", id: values["agent-id"], file: `/tmp/${values["agent-id"]}.jsonl`, cwd: "/tmp",
      title: "fixture agent", model: "m", role: "main", parent: null, startedAt: now, updatedAt: now, endedAt: null, status: "running",
      live: { alive: true, state: "model", since: now, doing: "thinking", turnOpen: true },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, counts: { turns: 1, tools: 0, errors: 0, subagents: 0, events: 0 },
    },
  });
}
if (values["die-after"]) setTimeout(() => process.exit(3), Number(values["die-after"]));
