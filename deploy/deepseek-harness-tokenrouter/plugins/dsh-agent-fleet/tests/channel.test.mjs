// Transport lifecycle rules of lib/channel.mjs that callers rely on.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

const channelUrl = new URL("../lib/channel.mjs", import.meta.url).href;

test("closing a spawn transport whose command could not start leaves the caller's process group alone", async () => {
  // The probe closes the transport before Node reports ENOENT, while the child has no pid yet.
  const probe = `import { spawnTransport } from ${JSON.stringify(channelUrl)};
const transport = spawnTransport("/nonexistent/agent-fleet-test-command", []);
transport.child.on("error", () => {});
transport.close();
setTimeout(() => process.stdout.write("alive"), 200);`;
  // detached: the probe leads its own process group, so a signal to "pid 0" cannot reach the test runner.
  const child = spawn(process.execPath, ["--input-type=module", "-e", probe], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { out += chunk; });
  const [code, signal] = await new Promise(resolve => child.on("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal])));
  assert.deepEqual({ code, signal, out }, { code: 0, signal: null, out: "alive" });
});
