#!/usr/bin/env bash
# Give a dsh-agent-fleet test pod a DSH `headless` profile that can run turns over ACP (claude / codex / omp).
#
#   provision-acp.sh <context> [options]
#
# <context>    any context of the kubeconfig: chengdu | weihai | ulanqab-iron | ulanqab-osmium
# options      --pod NAME        pod name (default agent-fleet-test-0)
#              --container NAME  container name (default workspace)
#              --check           verify only, change nothing: composition + one ACP handshake per agent (no model call)
#              --turn KIND       run one DSH headless turn on route acp-<kind> (claude | codex | omp)
#              --prompt TEXT     prompt for --turn (default: one native subagent running `uname -m`)
#              --rebuild         discard the build cache and rebuild the pod tree
# env          KUBECTL           kubectl binary (default: kubectl from PATH, else ~/.local/bin/kubectl, which
#                                is where server-bochao-01 keeps it — it is not on PATH there)
#              KUBECONFIG_FILE   kubeconfig (default ~/.config/agent-fleet/kubeconfig.yaml)
#              NAMESPACE         (mc-bochao-li)
#              CACHE             build cache (~/agent-fleet/.cache/acp-pod)
#              ADAPTER_SRC       the dsh-acp-adapter fork (~/agent-fleet/plugins/dsh-acp-adapter)
#              ACP_TOOLS_SRC     claude-agent-acp / codex-acp install (~/agent-fleet/tools/acp)
#
# Run it where the sources live: on server-bochao-01. Its kubectl knows all four contexts, and it holds the built
# adapter fork (737 MB with dev dependencies) and the ACP CLI install; the script prunes them to 46 MB + 74 MB,
# streams the result into the pod once, then wires the pod's profile to it.
#
# What lands in the pod (nothing lands on the Mac):
#   /opt/agent-tools/dsh/node_modules/@local/dsh-acp-adapter  the fork: shipped files + runtime deps only, its
#                                                             @deepseek-ai peers come from the pod's own DSH
#                                                             installation (one cordis instance, one version set)
#   /opt/agent-tools/acp                                      claude-agent-acp + codex-acp (+ probe.mjs); the two
#                                                             platform CLI bundles are left out because the agents
#                                                             run the pod's own claude / codex binaries
#   /root/.dsh/profiles/headless/{package.json,cordis.patch.yml}
#                                                             bundle row + the three agents
#   /root/.dsh/acp-model-{claude,codex,omp}.yml                per-run default-model overlays
#
# Credentials: the profile patch passes the pod's Secret-provided variables by reference
# (`!!js process.env.ANTHROPIC_AUTH_TOKEN`, …), so this script writes no secret anywhere; the overlay files carry
# only a provider/model pair.
#
# Idempotent: the tree is streamed only when the pod's stamp differs, files are replaced only when their bytes
# differ, and the JSON edit is a no-op the second time. A pod recreated from the StatefulSet loses /opt and /root,
# so re-run this (plus `apply-test-pods.sh <context> provision` for the four agent CLIs).
set -euo pipefail

usage() { awk 'NR > 1 && /^set -e/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}" >&2; }

CTX=${1:-}
if [[ -z $CTX || $CTX == -h || $CTX == --help ]]; then usage; exit 2; fi
shift
POD=agent-fleet-test-0
CONTAINER=workspace
MODE=apply
KIND=
PROMPT=
REBUILD=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --pod) POD=${2:?}; shift 2 ;;
    --container) CONTAINER=${2:?}; shift 2 ;;
    --check) MODE=check; shift ;;
    --turn) KIND=${2:?}; MODE=turn; shift 2 ;;
    --prompt) PROMPT=${2:?}; shift 2 ;;
    --rebuild) REBUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "provision-acp: unknown argument $1" >&2; usage; exit 2 ;;
  esac
done
if [[ $MODE == turn && $KIND != claude && $KIND != codex && $KIND != omp ]]; then
  echo "provision-acp: --turn needs claude, codex or omp" >&2; exit 2
fi

NAMESPACE=${NAMESPACE:-mc-bochao-li}
if [[ -z ${KUBECONFIG_FILE:-} ]]; then
  KUBECONFIG_FILE=$HOME/.config/agent-fleet/kubeconfig.yaml
  [[ -r $KUBECONFIG_FILE ]] || KUBECONFIG_FILE=$HOME/Documents/dsh-credentials/kubeconfig.yaml
fi
CACHE=${CACHE:-$HOME/agent-fleet/.cache/acp-pod}
ADAPTER_SRC=${ADAPTER_SRC:-$HOME/agent-fleet/plugins/dsh-acp-adapter}
ACP_TOOLS_SRC=${ACP_TOOLS_SRC:-$HOME/agent-fleet/tools/acp}
DEFAULT_PROMPT='Use the Task tool (codex: your subagent tool) exactly once to run one subagent that executes the shell command: uname -m. Then reply DONE.'

die() { echo "provision-acp: $*" >&2; exit 1; }
note() { echo "provision-acp: $*"; }
# kubectl is not on PATH on server-bochao-01 (it lives in ~/.local/bin), so fall back to the two usual spots.
if [[ -z ${KUBECTL:-} ]]; then
  KUBECTL=$(command -v kubectl || true)
  for candidate in "$HOME/.local/bin/kubectl" "$HOME/bin/kubectl"; do
    if [[ -z $KUBECTL && -x $candidate ]]; then KUBECTL=$candidate; break; fi
  done
  [[ -n $KUBECTL ]] || die "kubectl not found: put it on PATH or set KUBECTL=/path/to/kubectl"
fi
kc() { "$KUBECTL" --kubeconfig "$KUBECONFIG_FILE" --context "$CTX" -n "$NAMESPACE" "$@"; }
exec_in() { kc exec "$POD" -c "$CONTAINER" -i -- "$@"; }   # keeps stdin open (tar, or a script via `bash -s`)
run_in() { kc exec "$POD" -c "$CONTAINER" -- "$@"; }

# ------------------------------------------------------------------ artifacts (server side, cached)

profile_patch_text() {
  cat <<'YAML'
# ACP agents for the dsh-agent-fleet test pod (dsh-acp-adapter fork + claude-agent-acp / codex-acp / omp).
# Credentials are read from the pod environment (K8s Secret env) when the profile loads: no secret is stored here.
# Written by deploy/k8s/provision-acp.sh; re-running it replaces this file only when its content changed.
- id: dsh-acp-adapter
  config:
    toolApprovalDefault: auto
    teamBridge: false
    agents:
      claude:
        name: Claude Code (TokenRouter)
        runtime: claude
        command: /usr/local/bin/node
        args:
          - /opt/agent-tools/acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js
        env:
          ANTHROPIC_BASE_URL: !!js process.env.ANTHROPIC_BASE_URL ?? ""
          ANTHROPIC_AUTH_TOKEN: !!js process.env.ANTHROPIC_AUTH_TOKEN ?? ""
          ANTHROPIC_API_KEY: !!js process.env.ANTHROPIC_API_KEY ?? ""
          API_TIMEOUT_MS: "3000000"
          CLAUDE_CODE_EXECUTABLE: /opt/agent-tools/claude/node_modules/@anthropic-ai/claude-code-linux-x64/claude
          DSH_CLAUDE_EXECUTABLE: /opt/agent-tools/claude/node_modules/@anthropic-ai/claude-code-linux-x64/claude
          PATH: /opt/agent-tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      codex:
        name: Codex (TokenRouter)
        runtime: codex
        command: /usr/local/bin/node
        args:
          - /opt/agent-tools/acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js
        env:
          OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY ?? ""
          CODEX_PATH: /opt/agent-tools/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
          PATH: /opt/agent-tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      omp:
        name: Oh My Pi (TokenRouter)
        command: /opt/agent-tools/bin/omp
        args: [acp]
        env:
          TOKENROUTER_API_KEY: !!js process.env.TOKENROUTER_API_KEY ?? ""
          PI_CODING_AGENT_DIR: /root/.omp/agent
          PATH: /opt/agent-tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
YAML
}

probe_source() {
  cat <<'PROBE'
// One-shot ACP handshake probe: spawn an ACP agent, initialize, open a session, print the model catalog.
// Usage: node probe.mjs <command> [args...]   (inherits the current environment; makes no model call)
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error('usage: probe.mjs <command> [args...]');
  process.exit(2);
}
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, cwd: process.cwd() });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
const pending = new Map();
let nextId = 0;
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject, method });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const lines = createInterface({ input: child.stdout });
const timer = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, agent: command, error: 'timeout', stderr: stderr.slice(-1200) }));
  child.kill('SIGKILL');
  process.exit(0);
}, 90_000);
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && message.method === undefined) {
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === 'session/request_permission') {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } })}\n`);
    return;
  }
  if (message.id !== undefined) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported' } })}\n`);
  }
});
try {
  const init = await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
  const session = await call('session/new', { cwd: process.cwd(), mcpServers: [] });
  const options = session.configOptions ?? [];
  const models = options.find((option) => String(option.category ?? option.id).toLowerCase() === 'model');
  console.log(JSON.stringify({
    ok: true,
    agent: init.agentInfo?.name ?? null,
    version: init.agentInfo?.version ?? null,
    sessionId: session.sessionId ?? null,
    currentModel: models?.currentValue ?? null,
    modelCount: models?.options?.length ?? 0,
  }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, agent: command, error: String(error), stderr: stderr.slice(-1200) }));
} finally {
  clearTimeout(timer);
  child.stdin.end();
  child.kill('SIGTERM');
}
PROBE
}

build() {
  local stamp_file=$CACHE/stamp adapter_version acp_version
  [[ -f $ADAPTER_SRC/package.json ]] || die "no adapter at $ADAPTER_SRC"
  [[ -f $ACP_TOOLS_SRC/node_modules/@agentclientprotocol/claude-agent-acp/package.json ]] ||
    die "no claude-agent-acp under $ACP_TOOLS_SRC"
  adapter_version=$(node -p "require('$ADAPTER_SRC/package.json').version")
  acp_version=$(node -p "require('$ACP_TOOLS_SRC/node_modules/@agentclientprotocol/claude-agent-acp/package.json').version + '-' + require('$ACP_TOOLS_SRC/node_modules/@agentclientprotocol/codex-acp/package.json').version")
  if [[ $REBUILD -eq 0 && -f $stamp_file && $(cat "$stamp_file") == "$adapter_version $acp_version" ]]; then
    note "build cache current ($adapter_version, acp $acp_version)"
    return 0
  fi
  note "building the pod tree from $ADAPTER_SRC and $ACP_TOOLS_SRC"
  rm -rf "$CACHE"
  mkdir -p "$CACHE/adapter" "$CACHE/acp"
  # Shipped files only; runtime deps from npm's declared list. Peers stay out on purpose so the pod's DSH
  # installation supplies @deepseek-ai/* and @modelcontextprotocol/* at the versions its own plugins use.
  rsync -a --exclude node_modules --exclude src --exclude test --exclude scripts "$ADAPTER_SRC"/ "$CACHE/adapter"/
  ( cd "$CACHE/adapter" && npm install --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund \
      --no-package-lock --loglevel=error >"$CACHE/adapter.npm.log" 2>&1 ) ||
    { tail -n 20 "$CACHE/adapter.npm.log" >&2; die "npm install for the adapter failed"; }
  find "$CACHE/adapter/node_modules" -mindepth 2 -maxdepth 2 -type d -empty -delete 2>/dev/null || true
  # Exactly the versions the server verified. The two platform CLI bundles (255 MB + 427 MB) stay out: the agents
  # run the pod's own binaries through CLAUDE_CODE_EXECUTABLE / CODEX_PATH.
  cp "$ACP_TOOLS_SRC/package.json" "$CACHE/acp/package.json"
  rsync -a --exclude '@anthropic-ai/claude-agent-sdk-linux-x64' --exclude '@openai/codex-linux-x64' \
    "$ACP_TOOLS_SRC/node_modules/" "$CACHE/acp/node_modules/"
  probe_source > "$CACHE/acp/probe.mjs"
  printf '%s %s\n' "$adapter_version" "$acp_version" > "$stamp_file"
  note "built adapter $(du -sh "$CACHE/adapter" | cut -f1) and acp $(du -sh "$CACHE/acp" | cut -f1)"
}

tree_stamp() { tar -C "$CACHE" -cf - adapter acp | sha256sum | cut -c1-32; }

# ------------------------------------------------------------------ apply

stream_tree() { # $1 = tree stamp
  local stamp=$1
  tar -C "$CACHE" -cf - adapter acp | exec_in bash -lc "
set -e
rm -rf /opt/agent-tools/.acp-incoming
mkdir -p /opt/agent-tools/.acp-incoming /opt/agent-tools/dsh/node_modules/@local
tar -xf - -C /opt/agent-tools/.acp-incoming
rm -rf /opt/agent-tools/dsh/node_modules/@local/dsh-acp-adapter /opt/agent-tools/acp
mv /opt/agent-tools/.acp-incoming/adapter /opt/agent-tools/dsh/node_modules/@local/dsh-acp-adapter
mv /opt/agent-tools/.acp-incoming/acp /opt/agent-tools/acp
rmdir /opt/agent-tools/.acp-incoming
printf '%s\n' '$stamp' > /opt/agent-tools/.acp-tree.stamp
du -sh /opt/agent-tools/dsh/node_modules/@local/dsh-acp-adapter /opt/agent-tools/acp
" || die "streaming the tree into $POD failed"
}

# One script for the pod: bundle symlink + bundle row, profile patch, three model overlays. Every file is replaced
# only when its bytes differ, so a second run reports "unchanged" for all of them.
wire_profile() {
  {
    cat <<'POD'
set -e
D=/root/.dsh
P=$D/profiles/headless
PLUGIN=/opt/agent-tools/dsh/node_modules/@local/dsh-acp-adapter
mkdir -p "$P/node_modules/@local"
ln -sfn "$PLUGIN" "$P/node_modules/@local/dsh-acp-adapter"
node - "$P/package.json" "$PLUGIN" <<'JS'
const fs = require('fs');
const [file, plugin] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const want = '@local/dsh-acp-adapter';
p.dependencies = p.dependencies ?? {};
p.dependencies[want] = 'link:' + plugin;
p.dsh = p.dsh ?? {};
p.dsh.profile = p.dsh.profile ?? {};
p.dsh.profile.bundles = p.dsh.profile.bundles ?? [];
if (!p.dsh.profile.bundles.includes(want)) p.dsh.profile.bundles.push(want);
fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
console.log('bundles: ' + p.dsh.profile.bundles.join(' '));
JS
replace() { # <target> <new file> <label>
  if cmp -s "$2" "$1"; then rm -f "$2"; echo "$3: unchanged"; else mv "$2" "$1"; echo "$3: written"; fi
}
cat > /tmp/acp-profile.patch.yml <<'YAML'
POD
    profile_patch_text
    cat <<'POD'
YAML
cat > /tmp/acp-model-claude.yml <<'YAML'
- id: agent-default-model
  config:
    provider: acp-claude
    model: sonnet
YAML
cat > /tmp/acp-model-codex.yml <<'YAML'
- id: agent-default-model
  config:
    provider: acp-codex
    model: gpt-6.1-sol
YAML
cat > /tmp/acp-model-omp.yml <<'YAML'
- id: agent-default-model
  config:
    provider: acp-omp
    model: tokenrouter-v2/claude-sonnet-5.5
YAML
replace "$P/cordis.patch.yml" /tmp/acp-profile.patch.yml "profile patch"
replace "$D/acp-model-claude.yml" /tmp/acp-model-claude.yml "model overlay claude"
replace "$D/acp-model-codex.yml" /tmp/acp-model-codex.yml "model overlay codex"
replace "$D/acp-model-omp.yml" /tmp/acp-model-omp.yml "model overlay omp"
POD
  } | exec_in bash -s
}

apply() {
  local stamp pod_stamp
  build
  stamp=$(tree_stamp)
  pod_stamp=$(run_in bash -lc 'cat /opt/agent-tools/.acp-tree.stamp 2>/dev/null || true' | tr -d '\r\n')
  if [[ $pod_stamp == "$stamp" ]] && run_in bash -lc 'test -f /opt/agent-tools/dsh/node_modules/@local/dsh-acp-adapter/package.json && test -f /opt/agent-tools/acp/probe.mjs'; then
    note "pod tree current ($stamp)"
  else
    note "streaming tree $stamp into $POD"
    stream_tree "$stamp"
  fi
  wire_profile
  note "applied to $CTX/$POD"
}

# ------------------------------------------------------------------ verify

check() {
  local out
  out=$(run_in bash -lc '
set -u
D=/root/.dsh
P=$D/profiles/headless
PLUGIN=/opt/agent-tools/dsh/node_modules/@local/dsh-acp-adapter
bad=0
[ -f "$PLUGIN/package.json" ] && echo "plugin: present ($(node -p "require(\"$PLUGIN/package.json\").version"))" || { echo "plugin: MISSING"; bad=1; }
[ -f /opt/agent-tools/acp/probe.mjs ] && echo "acp tools: present" || { echo "acp tools: MISSING"; bad=1; }
echo "tree stamp: $(cat /opt/agent-tools/.acp-tree.stamp 2>/dev/null || echo none)"
echo "symlink: $(readlink "$P/node_modules/@local/dsh-acp-adapter" 2>/dev/null || echo MISSING)"
echo "bundles: $(node -p "require(\"$P/package.json\").dsh.profile.bundles.join(\",\")" 2>/dev/null || echo MISSING)"
if dsh --profile headless --dump-config >/tmp/acp-dump.yml 2>/tmp/acp-dump.err; then echo "compose: ok"; else echo "compose: FAILED"; tail -n 3 /tmp/acp-dump.err; bad=1; fi
for name in "Claude Code (TokenRouter)" "Codex (TokenRouter)" "Oh My Pi (TokenRouter)"; do
  if grep -qF "name: $name" /tmp/acp-dump.yml; then echo "agent: $name"; else echo "agent MISSING: $name"; bad=1; fi
done
for key in ANTHROPIC_AUTH_TOKEN OPENAI_API_KEY TOKENROUTER_API_KEY; do
  echo "env $key: $(grep -cE "^ +$key: [^ ]" /tmp/acp-dump.yml) value(s) resolved from the pod environment"
done
# The composed dump carries the resolved credentials: never leave it behind.
rm -f /tmp/acp-dump.yml /tmp/acp-dump.err
echo "probe claude: $(CLAUDE_CODE_EXECUTABLE=/opt/agent-tools/claude/node_modules/@anthropic-ai/claude-code-linux-x64/claude node /opt/agent-tools/acp/probe.mjs /usr/local/bin/node /opt/agent-tools/acp/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js)"
echo "probe codex: $(CODEX_PATH=/opt/agent-tools/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex node /opt/agent-tools/acp/probe.mjs /usr/local/bin/node /opt/agent-tools/acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js)"
echo "probe omp: $(node /opt/agent-tools/acp/probe.mjs /opt/agent-tools/bin/omp acp)"
exit $bad
' 2>&1) || { printf '%s\n' "$out"; die "check failed on $CTX/$POD"; }
  printf '%s\n' "$out"
  note "check passed on $CTX/$POD"
}

# ------------------------------------------------------------------ one turn

turn() {
  local prompt=${PROMPT:-$DEFAULT_PROMPT}
  run_in bash -lc 'cd /work && timeout 900 dsh --profile headless --patch "/root/.dsh/acp-model-$1.yml" "$2" 2>&1 | tail -n 8' sh "$KIND" "$prompt"
}

case $MODE in
  apply) apply ;;
  check) check ;;
  turn) turn ;;
esac