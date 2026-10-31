#!/usr/bin/env node
// agent-fleet command line: collector | hub | edge | status | bundle. Each subcommand module is imported only when
// it runs, so `collector` never loads the hub or the edge (and the single-file collector bundle does not contain them).
const USAGE = `usage: agent-fleet <command> [options]
  collector   report this machine's agent sessions to a hub (--stdio | --connect HOST:PORT | --ssh TARGET)
  hub         run the fleet hub (state, HTTP API + panel, collector ingest, kube watch)
  edge        run the edge reverse proxy (/fleet → hub, /dsh → DSH Web)
  status      print a hub's health and host list (--url, --token-file)
  bundle      build dist/agent-fleet-collector.mjs, the single-file collector for pods (--out FILE)
Run \`agent-fleet <command> --help\` for the options of a command.
`;

const [command, ...args] = process.argv.slice(2);

async function run() {
  switch (command) {
    case "collector": return (await import("../lib/collector/main.mjs")).collectorMain(args);
    case "hub": return (await import("../lib/hub/index.mjs")).hubMain(args);
    case "edge": return (await import("../lib/edge.mjs")).edgeMain(args);
    case "status": return (await import("../lib/status.mjs")).statusMain(args);
    case "bundle": {
      const { buildCollector } = await import("../tools/build-collector.mjs");
      const at = args.indexOf("--out");
      const result = buildCollector(at >= 0 ? { out: args[at + 1] } : {});
      process.stdout.write(`${result.file}  ${result.bytes} bytes  sha256 ${result.sha256.slice(0, 16)}  ${result.modules.length} modules\n`);
      return undefined;
    }
    case undefined: case "help": case "--help": case "-h":
      process.stdout.write(USAGE);
      return undefined;
    default:
      process.stderr.write(`agent-fleet: unknown command "${command}"\n${USAGE}`);
      process.exitCode = 2;
      return undefined;
  }
}

try { await run(); } catch (error) {
  process.stderr.write(`agent-fleet ${command ?? ""}: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
