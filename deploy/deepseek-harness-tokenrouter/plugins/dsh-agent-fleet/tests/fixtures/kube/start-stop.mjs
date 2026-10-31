// Child process of the spawn-failure regression test in tests/kube.test.mjs. argv[2] is a kubectl that cannot be executed.
// It starts a source and stops it in the same tick, while the children whose spawn failed are still registered. Such a
// child has no pid until its 'error' event, and ChildProcess.kill() on it signals pid 0 (the caller's whole process group)
// or whatever stale value libuv's uninitialised handle holds. kill() is intercepted to record which signals were aimed at
// children without a pid; those calls are swallowed, so this experiment can never signal anything it should not.
import { ChildProcess, spawn } from "node:child_process";
import { createKubeSource } from "../../../lib/hub/sources/kube.mjs";

const kills = [];
const realKill = ChildProcess.prototype.kill;
ChildProcess.prototype.kill = function kill(signal) {
  kills.push({ hasPid: Boolean(this.pid), signal });
  return this.pid ? realKill.call(this, signal) : false;
};

// Control: the interception does see the kill of a healthy child, so an empty result below means something.
const control = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
control.kill("SIGTERM");
const controlSeen = kills.length === 1 && kills[0].hasPid;
kills.length = 0;

const source = createKubeSource({ kubeconfig: "/nonexistent/kubeconfig.yaml", kubectl: process.argv[2], sites: { os: "ctx-os" } });
source.start();
const lookup = source.getPod({ site: "os", name: "some-pod" }).then(() => "resolved", () => "rejected");
await source.stop();
console.log(JSON.stringify({ controlSeen, killsWithoutPid: kills.filter(kill => !kill.hasPid), lookup: await lookup }));
