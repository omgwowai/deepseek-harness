// Test fixture: run a node CLI script (top-level code, ends with process.exit) in a worker thread instead of a child process.
// Same contract as spawnSync(process.execPath, [script, ...args]) for what the tests look at: { status, stdout }.
// - process.exit(N) in a worker ends only that thread; its exit code is N (0 when the script just finishes).
// - process.argv = [execPath, script, ...args]; env is a copy of the caller's process.env at call time (or opts.env).
// - stdout / stderr are captured separately.
// Why (2026-11-08): the hindsight patch tests ran ~10 patch CLIs each; under a loaded gate each node start costs 150 ms+.
// Only tests that look at status / stdout use it; a script that itself spawns processes (node --check) still does so.
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

export function runScript(script, args = [], { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(pathToFileURL(script), { argv: args, env: { ...env }, stdout: true, stderr: true });
    let stdout = '';
    let stderr = '';
    let status;
    let pending = 3; // exit + stdout end + stderr end:输出读完才返回
    const done = () => { if (--pending === 0) resolve({ status, stdout, stderr }); };
    w.stdout.setEncoding('utf8').on('data', (d) => (stdout += d)).on('end', done);
    w.stderr.setEncoding('utf8').on('data', (d) => (stderr += d)).on('end', done);
    w.on('error', reject);
    w.on('exit', (code) => { status = code; done(); });
  });
}
