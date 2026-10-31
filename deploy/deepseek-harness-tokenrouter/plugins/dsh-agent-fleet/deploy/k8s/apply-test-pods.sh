#!/usr/bin/env bash
# Create / provision / smoke-test / delete the disposable dsh-agent-fleet test pod on one cluster.
#
#   apply-test-pods.sh <context> [command] [args]
#
# <context>  chengdu | weihai | ulanqab-iron | ulanqab-osmium (any context of the kubeconfig; hostAliases for
#            tokenrouterv2.omgwow.tech are added on every context except chengdu, whose in-cluster DNS works)
# commands   render              print the manifest for this context
#            secret <env-file>   create/update Secret agent-fleet-agents from a 0600 KEY=VALUE file
#                                (TOKENROUTER_API_KEY OPENAI_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_API_KEY)
#            apply (default)     apply the StatefulSet and wait until agent-fleet-test-0 is Ready
#            provision           install dsh/claude/codex/omp/bun (npm, from inside the pod) + wrappers + agent configs
#                                (AGENT_TOOLS_BUNDLE=<tgz> streams an offline bundle first instead of downloading)
#            smoke [kind...]     "Reply with exactly: ok" + one subagent spawn per kind (dsh claude codex omp): PASS/FAIL
#            run <kind> <prompt> start one detached agent run (survives the kubectl exec); cwd/logs: /work/runs/<ts>-<kind>/
#            status              pod phase + installed agent versions
#            pod-script          print the script that `provision` runs inside the pod (agent-tools-setup)
#            delete [--all]      delete the StatefulSet and its pod (--all: also the Secret)
# env        KUBECONFIG_FILE (default ~/.config/agent-fleet/kubeconfig.yaml, else ~/Documents/dsh-credentials/kubeconfig.yaml)
#            NAMESPACE (mc-bochao-li)  IMAGE  TOKENROUTER_IP (10.0.60.77)  WAIT (rollout timeout, 600s)
#            PROVISION_TIMEOUT (seconds, 1800)  AGENT_TOOLS_BUNDLE
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MANIFEST=$HERE/agent-fleet-test.yaml
NS=${NAMESPACE:-mc-bochao-li}
STS=agent-fleet-test
POD=$STS-0
CONTAINER=workspace
SECRET=agent-fleet-agents
IMAGE=${IMAGE:-harbor.omgwow.ai/dockerhub-cache/library/node:22-bookworm}
TOKENROUTER_IP=${TOKENROUTER_IP:-10.0.60.77}
KUBECTL=${KUBECTL:-$(command -v kubectl || echo "$HOME/bin/kubectl")}
if [[ -z ${KUBECONFIG_FILE:-} ]]; then
  KUBECONFIG_FILE=$HOME/.config/agent-fleet/kubeconfig.yaml
  [[ -r $KUBECONFIG_FILE ]] || KUBECONFIG_FILE=$HOME/Documents/dsh-credentials/kubeconfig.yaml
fi

die() { echo "apply-test-pods: $*" >&2; exit 1; }
usage() { awk 'NR > 1 && /^set -e/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}" >&2; exit 2; }

[[ $# -ge 1 ]] || usage
CTX=$1; shift
CMD=${1:-apply}; [[ $# -gt 0 ]] && shift

kc() { "$KUBECTL" --kubeconfig "$KUBECONFIG_FILE" --context "$CTX" -n "$NS" "$@"; }
pexec() { kc exec "$POD" -c "$CONTAINER" "$@"; }

render() {
  local aliases=""
  if [[ $CTX != chengdu ]]; then
    aliases=$'hostAliases:\n        - ip: "'$TOKENROUTER_IP$'"\n          hostnames: ["tokenrouterv2.omgwow.tech"]'
  fi
  local doc; doc=$(<"$MANIFEST")
  doc=${doc//@IMAGE@/$IMAGE}
  doc=${doc//@HOST_ALIASES@/$aliases}
  printf '%s\n' "$doc"
}

cmd_secret() {
  local f=${1:-}; [[ -n $f && -r $f ]] || die "usage: $0 $CTX secret <env-file>"
  local mode; mode=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")
  [[ $mode == 600 ]] || die "$f must be mode 0600 (is $mode)"
  local k
  for k in TOKENROUTER_API_KEY OPENAI_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_API_KEY; do
    grep -q "^$k=" "$f" || die "$f lacks $k"
  done
  kc create secret generic "$SECRET" --from-env-file="$f" --dry-run=client -o yaml | kc apply -f -
}

pod_script() {
  cat <<'__AGENT_TOOLS_SETUP__'
#!/bin/sh
# agent-tools-setup — runs INSIDE the test pod (root, node:22-bookworm). Idempotent; writes no secrets.
#   install     npm-install dsh / claude / codex / omp / bun under /opt/agent-tools/<tool> (skipped per tool when the
#               pinned version is already there, e.g. after unpacking the offline bundle)
#   wrappers    /opt/agent-tools/bin/{dsh,claude,codex,omp,bun} + /usr/local/bin symlinks + /etc/profile.d/agent-tools.sh
#   configure   agent configs under $HOME (DSH home patch, Claude settings, Codex config.toml, OMP models.yml/config.yml)
#   dsh-profile DSH `headless` profile carrying @tokenrouter/dsh-telemetry (TokenRouter answers 403 to DSH without it)
#   all         everything above; writes /opt/agent-tools/.ready (versions) or .failed
#   smoke [kind...]  one-shot + subagent smoke for dsh claude codex omp (all by default); PASS/FAIL table, no model output
set -u
T=/opt/agent-tools
DSH_VERSION=${DSH_VERSION:-0.2.1-rc.2}
CLAUDE_VERSION=${CLAUDE_VERSION:-2.1.314}
CODEX_VERSION=${CODEX_VERSION:-0.166.0}
OMP_VERSION=${OMP_VERSION:-18.14.0}
BUN_VERSION=${BUN_VERSION:-1.4.4}
TELEMETRY_VERSION=${TELEMETRY_VERSION:-0.3.2}
TELEMETRY_SHA256=${TELEMETRY_SHA256:-dd296a9fe492c7d190fc3799f06a5f869be5e6e1354a2b3130bb821b6db83eb9}

npm_install() { # <tool> <version> <npm args...>   ($T/<tool>/.version marks success)
  tool=$1 ver=$2; shift 2
  if [ "$(cat "$T/$tool/.version" 2>/dev/null || true)" = "$ver" ]; then echo "[$tool] $ver already present"; return 0; fi
  rm -rf "${T:?}/$tool"; mkdir -p "$T/$tool" "$T/log"
  ( cd "$T/$tool" && echo "{\"name\":\"agent-tools-$tool\",\"private\":true}" > package.json &&
    npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock --loglevel=error \
      --cache "$T/.npm-cache" "$@" ) > "$T/log/$tool.log" 2>&1 || { echo "[$tool] npm install FAILED:"; tail -n 20 "$T/log/$tool.log"; return 1; }
  echo "$ver" > "$T/$tool/.version"; echo "[$tool] $ver installed"
}

do_install() {
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=15)?0:1)' ||
    { echo "node $(node -v) is older than 22.15"; return 1; }
  mkdir -p "$T/bin" "$T/log"
  pids=""
  npm_install bun    "$BUN_VERSION"    "bun@$BUN_VERSION" & pids="$pids $!"
  npm_install codex  "$CODEX_VERSION"  "@openai/codex@$CODEX_VERSION" & pids="$pids $!"
  npm_install claude "$CLAUDE_VERSION" "@anthropic-ai/claude-code@$CLAUDE_VERSION" & pids="$pids $!"
  # omp: skip optional deps (onnxruntime / transformers / sherpa, ~700 MB, unused) but keep its linux-x64 native addon.
  npm_install omp    "$OMP_VERSION"    --omit=optional "@oh-my-pi/pi-coding-agent@$OMP_VERSION" "@oh-my-pi/pi-natives-linux-x64@$OMP_VERSION" & pids="$pids $!"
  npm_install dsh    "$DSH_VERSION"    "@deepseek-ai/dsh@$DSH_VERSION" & pids="$pids $!"
  rc=0; for p in $pids; do wait "$p" || rc=1; done
  rm -rf "$T/.npm-cache"
  return $rc
}

do_wrappers() {
  mkdir -p "$T/bin"
  cat > "$T/bin/dsh" <<'EOF'
#!/bin/sh
exec node /opt/agent-tools/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
EOF
  cat > "$T/bin/claude" <<'EOF'
#!/bin/sh
exec /opt/agent-tools/claude/node_modules/@anthropic-ai/claude-code-linux-x64/claude "$@"
EOF
  cat > "$T/bin/codex" <<'EOF'
#!/bin/sh
export CODEX_MANAGED_BY_NPM=1 CODEX_MANAGED_PACKAGE_ROOT=/opt/agent-tools/codex/node_modules/@openai/codex
exec /opt/agent-tools/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex "$@"
EOF
  cat > "$T/bin/omp" <<'EOF'
#!/bin/sh
exec /opt/agent-tools/bun/node_modules/@oven/bun-linux-x64/bin/bun /opt/agent-tools/omp/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js "$@"
EOF
  cat > "$T/bin/bun" <<'EOF'
#!/bin/sh
exec /opt/agent-tools/bun/node_modules/@oven/bun-linux-x64/bin/bun "$@"
EOF
  chmod 755 "$T"/bin/dsh "$T"/bin/claude "$T"/bin/codex "$T"/bin/omp "$T"/bin/bun
  for t in dsh claude codex omp bun; do ln -sf "$T/bin/$t" "/usr/local/bin/$t"; done
  cat > /etc/profile.d/agent-tools.sh <<'EOF'
case ":$PATH:" in *:/opt/agent-tools/bin:*) ;; *) export PATH="/opt/agent-tools/bin:$PATH" ;; esac
EOF
}

do_configure() {
  mkdir -p "$HOME/.dsh" "$HOME/.claude" "$HOME/.codex" "$HOME/.omp/agent" /work
  chmod 700 "$HOME"

  # DSH: home-level patch layer ($DSH_HOME/cordis.patch.yml, applies to every profile). Same shape as the Mac's.
  cat > "$HOME/.dsh/cordis.patch.yml" <<'EOF'
[
  {
    "id": "agent-default-model",
    "config": { "provider": "tokenrouter-deepseek-1017", "model": "deepseek-v4.1-flash-1017", "reasoningEffort": "max" }
  },
  {
    "id": "llm-pi-ai",
    "config": {
      "providers": {
        "tokenrouter-deepseek-1017": {
          "displayName": "TokenRouter V2 · DeepSeek V4.1 Flash 1017 (tencent only)",
          "api": "openai-completions",
          "baseURL": "https://tokenrouterv2.omgwow.tech/v1",
          "apiKeyEnv": "TOKENROUTER_API_KEY",
          "headers": { "X-Force-Provider": "tencent" },
          "compat": {
            "supportsStore": false,
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": true,
            "maxTokensField": "max_tokens",
            "requiresReasoningContentOnAssistantMessages": true,
            "thinkingFormat": "deepseek"
          },
          "models": [
            {
              "id": "deepseek-v4.1-flash-1017",
              "name": "DeepSeek V4.1 Flash 1017",
              "contextWindow": 1048576,
              "maxTokens": 131072,
              "input": ["text", "image"],
              "reasoningEfforts": { "high": "high", "max": "max" }
            }
          ]
        }
      }
    }
  },
  {
    "id": "tool-subagent",
    "config": {
      "provider": "spawn",
      "toolName": "subagent",
      "agentOptions": { "provider": "tokenrouter-deepseek-1017", "model": "deepseek-v4.1-flash-1017", "reasoningEffort": "max" }
    }
  }
]
EOF

  # Claude Code: models only; ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY come from the pod env.
  cat > "$HOME/.claude/settings.json" <<'EOF'
{
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5.5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5.5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-sonnet-5.5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-sonnet-5.5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "claude-sonnet-5.5"
  },
  "model": "claude-sonnet-5.5",
  "skipDangerousModePermissionPrompt": true
}
EOF
  cat > "$HOME/.claude.json" <<'EOF'
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true,
  "projects": { "/work": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } }
}
EOF

  # Codex: key from the env (env_key); pods are disposable, so no approvals and no sandbox. The update check and the
  # plugin marketplace sync (a git clone of github.com/openai/plugins on every start) are off: they stall startup
  # where the internet is only reachable through a proxy.
  cat > "$HOME/.codex/config.toml" <<'EOF'
model = "gpt-6.1-sol"
model_provider = "tokenrouter"
approval_policy = "never"
sandbox_mode = "danger-full-access"
check_for_update_on_startup = false

[features]
plugins = false

[model_providers.tokenrouter]
name = "TokenRouter"
base_url = "https://tokenrouterv2.omgwow.tech/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
http_headers = { "x-tokenrouter-codex" = "1" }

[projects."/work"]
trust_level = "trusted"
EOF

  # OMP: the provider apiKey is an env var NAME that omp resolves from the pod env, never the key itself.
  cat > "$HOME/.omp/agent/models.yml" <<'EOF'
providers:
  tokenrouter-v2:
    baseUrl: https://tokenrouterv2.omgwow.tech/v1
    disableStrictTools: true
    apiKey: TOKENROUTER_API_KEY
    models:
      - id: claude-opus-5.5
        name: Claude Opus 5.5
        api: anthropic-messages
        reasoning: true
        input: [text, image]
        supportsTools: true
        contextWindow: 1000000
        maxTokens: 128000
        thinking: { mode: anthropic-adaptive, efforts: [low, medium, high, max] }
      - id: claude-sonnet-5.5
        name: Claude Sonnet 5.5
        api: anthropic-messages
        reasoning: true
        input: [text, image]
        supportsTools: true
        contextWindow: 1000000
        maxTokens: 128000
        thinking: { mode: anthropic-adaptive, efforts: [low, medium, high, max] }
      - id: gpt-6.1-sol
        name: GPT-6.1 Sol (v2)
        api: openai-responses
        reasoning: true
        input: [text, image]
        supportsTools: true
        contextWindow: 1050000
        maxTokens: 128000
        thinking: { mode: effort, efforts: [low, medium, high, xhigh] }
      - id: deepseek-v4.1-flash-1017
        name: DeepSeek V4.1 Flash 1017 (v2)
        api: openai-completions
        headers: { X-Force-Provider: tencent }
        reasoning: true
        input: [text, image]
        supportsTools: true
        contextWindow: 1048576
        maxTokens: 131072
        thinking: { mode: effort, efforts: [high, max] }
EOF
  cat > "$HOME/.omp/agent/config.yml" <<'EOF'
symbolPreset: ascii
setupVersion: 2
modelRoles:
  default: tokenrouter-v2/claude-sonnet-5.5
  smol: tokenrouter-v2/gpt-6.1-sol
  slow: tokenrouter-v2/gpt-6.1-sol
  plan: tokenrouter-v2/gpt-6.1-sol
  vision: tokenrouter-v2/gpt-6.1-sol
  commit: tokenrouter-v2/gpt-6.1-sol
  tiny: tokenrouter-v2/gpt-6.1-sol
  memory: tokenrouter-v2/gpt-6.1-sol
  task: tokenrouter-v2/claude-sonnet-5.5
  advisor: tokenrouter-v2/gpt-6.1-sol
  judge: tokenrouter-v2/gpt-6.1-sol
providers:
  streamFirstEventTimeoutSeconds: 300
  streamIdleTimeoutSeconds: 300
task:
  agentModelOverrides:
    task: tokenrouter-v2/claude-sonnet-5.5
    scout: tokenrouter-v2/claude-sonnet-5.5
    sonic: tokenrouter-v2/claude-sonnet-5.5
    reviewer: tokenrouter-v2/claude-sonnet-5.5
EOF
  chmod 600 "$HOME/.claude/settings.json" "$HOME/.claude.json" "$HOME/.codex/config.toml" \
    "$HOME/.omp/agent/models.yml" "$HOME/.omp/agent/config.yml" "$HOME/.dsh/cordis.patch.yml"
}

# DSH headless profile + @tokenrouter/dsh-telemetry (TokenRouter's gateway rejects DSH model requests without it).
# The plugin is a dependency-free bundle; unpacking it into the profile's node_modules is what `dsh plugin add` does.
do_dsh_profile() {
  p=$HOME/.dsh/profiles/headless
  tgz=$HOME/.dsh/dsh-telemetry-$TELEMETRY_VERSION.tgz
  mkdir -p "$p/node_modules/@tokenrouter/dsh-telemetry"
  if [ ! -s "$tgz" ]; then
    curl -fsSL --retry 3 --max-time 180 -o "$tgz" "https://tokenrouterv2.omgwow.tech/docs/dsh-telemetry-$TELEMETRY_VERSION.tgz" ||
      { echo "cannot download dsh-telemetry-$TELEMETRY_VERSION.tgz"; rm -f "$tgz"; return 1; }
  fi
  echo "$TELEMETRY_SHA256  $tgz" | sha256sum -c - >/dev/null || { echo "dsh-telemetry tarball checksum mismatch"; rm -f "$tgz"; return 1; }
  tar -xzf "$tgz" -C "$p/node_modules/@tokenrouter/dsh-telemetry" --strip-components=1
  cat > "$p/package.json" <<EOF
{
  "name": "dsh-profile-headless",
  "private": true,
  "dependencies": { "@tokenrouter/dsh-telemetry": "file:$tgz" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@tokenrouter/dsh-telemetry"] } }
}
EOF
}

# ---- smoke: "Reply with exactly: ok" one-shot and one subagent spawn per kind -------------------------------------
SMOKE_ONE='Reply with exactly: ok'
SMOKE_SUB_claude='Spawn exactly one subagent with your Task/Agent tool. The subagent prompt must be: Reply with exactly: ok. When it returns, reply with exactly: ok'
SMOKE_SUB_codex='Spawn exactly one subagent (your spawn_agent / multi-agent tool). Its task: reply with exactly: ok. Wait for it to finish, then reply with exactly: ok'
SMOKE_SUB_omp='Use your task tool exactly once to spawn one subagent whose assignment is: reply with exactly: ok. When it returns, reply with exactly: ok'
SMOKE_SUB_dsh='Use your subagent tool exactly once to spawn one subagent whose task is: reply with exactly: ok. When it returns, reply with exactly: ok'

smoke_artifact() { # <kind> <stamp>: did this run leave a child (subagent) transcript behind?
  case $1 in
    claude) find "$HOME/.claude/projects" -path '*/subagents/agent-*.jsonl' -newer "$2" 2>/dev/null | grep -q . ;;
    codex) [ -n "$(find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -newer "$2" -exec grep -l thread_spawn {} + 2>/dev/null)" ] ;;
    omp) find "$HOME/.omp/agent/sessions" -mindepth 3 -name '*.jsonl' -newer "$2" 2>/dev/null | grep -q . ;;
    dsh) [ "$(find "$HOME/.dsh/sessions" -name 'session*.jsonl.zstd' -newer "$2" 2>/dev/null | wc -l)" -ge 2 ] ;;
  esac
}

smoke_case() { # <kind> <one|sub> <prompt>
  kind=$1 mode=$2 prompt=$3
  d=/work/smoke/$kind; mkdir -p "$d"; stamp=$d/.stamp-$mode; : > "$stamp"; sleep 1
  t0=$(date +%s)
  case $kind in
    claude) set -- claude -p "$prompt" --dangerously-skip-permissions ;;
    codex) set -- codex exec --skip-git-repo-check "$prompt" ;;
    omp) set -- omp -p "$prompt" ;;
    dsh) set -- dsh headless "$prompt" ;;
  esac
  out=$(cd "$d" && timeout "${SMOKE_TIMEOUT:-600}" "$@" 2>"$d/$mode.err" </dev/null); rc=$?
  last=$(printf '%s\n' "$out" | tail -n 1 | tr -cd 'A-Za-z' | tr 'A-Z' 'a-z')
  res=PASS; why=""
  [ "$rc" -eq 0 ] || { res=FAIL; why="exit=$rc"; }
  [ "$last" = ok ] || { res=FAIL; why="$why answer-not-ok"; }
  if [ "$mode" = sub ] && ! smoke_artifact "$kind" "$stamp"; then res=FAIL; why="$why no-subagent-transcript"; fi
  printf '%-7s %-8s %-4s %3ss %s\n' "$kind" "$mode" "$res" "$(( $(date +%s) - t0 ))" "$why"
  [ "$res" = PASS ] || { echo "  stderr tail:"; tail -n 4 "$d/$mode.err" | cut -c1-240 | sed 's/^/    /'; return 1; }
}

do_smoke() {
  kinds=${*:-dsh claude codex omp}; fail=0
  for k in $kinds; do
    eval "sub=\$SMOKE_SUB_$k"
    smoke_case "$k" one "$SMOKE_ONE" || fail=1
    smoke_case "$k" sub "$sub" || fail=1
  done
  return $fail
}

do_all() {
  rm -f "$T/.ready" "$T/.failed"
  set +e
  ( set -e; do_install; do_wrappers; do_configure; do_dsh_profile )
  rc=$?
  if [ "$rc" -eq 0 ]; then
    for t in dsh claude codex omp bun; do printf '%s %s\n' "$t" "$(cat "$T/$t/.version")"; done > "$T/.ready"
    echo "agent-tools-setup: ready"
  else
    touch "$T/.failed"; echo "agent-tools-setup: FAILED (rc=$rc)"
  fi
  return $rc
}

case ${1:-all} in
  install) do_install ;;
  wrappers) do_wrappers ;;
  configure) do_configure ;;
  dsh-profile) do_dsh_profile ;;
  all) do_all ;;
  smoke) shift; do_smoke "$@" ;;
  *) echo "usage: agent-tools-setup install|wrappers|configure|dsh-profile|all|smoke [kind...]" >&2; exit 2 ;;
esac
__AGENT_TOOLS_SETUP__
}

cmd_provision() {
  kc wait --for=condition=Ready "pod/$POD" --timeout=300s >/dev/null
  if [[ -n ${AGENT_TOOLS_BUNDLE:-} ]]; then
    echo "streaming $AGENT_TOOLS_BUNDLE into the pod (slow link: expect ~0.5 MB/s)"
    pexec -i -- sh -c 'mkdir -p /opt/agent-tools && tar -xzf - -C /opt/agent-tools' < "$AGENT_TOOLS_BUNDLE"
  fi
  pod_script | pexec -i -- sh -c 'mkdir -p /opt/agent-tools/bin && cat > /opt/agent-tools/bin/agent-tools-setup && chmod 755 /opt/agent-tools/bin/agent-tools-setup'
  # Detached inside the pod: a dropped `kubectl exec` stream must not kill the installs; we poll for the marker files.
  pexec -- sh -c 'rm -f /opt/agent-tools/.ready /opt/agent-tools/.failed
    setsid nohup /opt/agent-tools/bin/agent-tools-setup all >/tmp/agent-tools-setup.log 2>&1 </dev/null &'
  local deadline=$((SECONDS + ${PROVISION_TIMEOUT:-1800})) state
  while ((SECONDS < deadline)); do
    sleep 10
    state=$(pexec -- sh -c 'if [ -f /opt/agent-tools/.ready ]; then echo ready; elif [ -f /opt/agent-tools/.failed ]; then echo failed; else echo running; fi' 2>/dev/null || echo unreachable)
    case $state in
      ready) pexec -- cat /tmp/agent-tools-setup.log; return 0 ;;
      failed) pexec -- cat /tmp/agent-tools-setup.log; die "provision failed on $CTX" ;;
    esac
  done
  die "provision timed out on $CTX (see /tmp/agent-tools-setup.log in the pod)"
}

cmd_smoke() { pexec -- /opt/agent-tools/bin/agent-tools-setup smoke "$@"; }

# One detached agent run: setsid + nohup inside the pod, so it outlives the `kubectl exec` that started it. The run
# directory is the agent's cwd (DSH's workspace-write sandbox only lets it write there); stdout/stderr go to out.log/err.log.
cmd_run() {
  local kind=${1:-}
  [[ $kind =~ ^(dsh|claude|codex|omp)$ && $# -ge 2 ]] || die "usage: $0 $CTX run <dsh|claude|codex|omp> <prompt>"
  shift
  local dir argv
  dir=/work/runs/$(date +%Y%m%d-%H%M%S)-$kind
  case $kind in
    claude) argv=(claude -p "$*" --dangerously-skip-permissions) ;;
    codex) argv=(codex exec --skip-git-repo-check "$*") ;;
    omp) argv=(omp -p "$*") ;;
    dsh) argv=(dsh headless "$*") ;;
  esac
  pexec -- sh -c 'd=$1; shift; mkdir -p "$d" && cd "$d" && { setsid nohup "$@" >out.log 2>err.log </dev/null & echo "started pid $! in $d"; }' sh "$dir" "${argv[@]}"
}

cmd_apply() {
  kc get secret "$SECRET" >/dev/null 2>&1 || die "Secret $SECRET missing in $CTX/$NS: run '$0 $CTX secret <env-file>' first"
  render | kc apply -f -
  kc rollout status "statefulset/$STS" --timeout="${WAIT:-600s}"
}

cmd_status() {
  kc get "pod/$POD" -o wide
  pexec -- sh -c 'cat /opt/agent-tools/.ready 2>/dev/null || echo "not provisioned"; for t in dsh claude codex omp; do printf "%s: " $t; (timeout 60 $t --version 2>&1 | head -1) || echo missing; done'
}

cmd_delete() {
  kc delete "statefulset/$STS" --ignore-not-found --wait=true
  [[ ${1:-} == --all ]] && kc delete secret "$SECRET" --ignore-not-found
  return 0
}

case $CMD in
  render) render ;;
  secret) cmd_secret "$@" ;;
  apply) cmd_apply ;;
  provision) cmd_provision ;;
  smoke) cmd_smoke "$@" ;;
  run) cmd_run "$@" ;;
  status) cmd_status ;;
  pod-script) pod_script ;;
  delete) cmd_delete "$@" ;;
  *) usage ;;
esac
