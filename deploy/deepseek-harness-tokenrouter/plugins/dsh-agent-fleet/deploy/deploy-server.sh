#!/usr/bin/env bash
# Deploy Agent Fleet to server-bochao-01 (10.0.60.98) and sg-compute from this checkout.
#
#   deploy/deploy-server.sh sync        copy the plugin to ~/agent-fleet/dsh-agent-fleet on the server (rsync, no secrets)
#   deploy/deploy-server.sh units       render + install the hub / DSH Web user units, (re)start them
#   deploy/deploy-server.sh edge-test   run a throwaway edge on 127.0.0.1:7849 and probe every route through it
#   deploy/deploy-server.sh cutover     move the TRTA v4 panel to 127.0.0.1:8464 and start the edge on :443
#   deploy/deploy-server.sh rollback    undo the cutover (panel back on 10.0.60.98:443, edge stopped)
#   deploy/deploy-server.sh sg          copy the plugin to sg-compute, its ingest token (0600), and (re)start its collector unit
#   deploy/deploy-server.sh status      unit states + health endpoints
#
# The panel cutover keeps the same public URLs (the edge's fallback route); the gap without a 443 listener is
# the time between stopping the panel's old listener and the edge binding, about one second.
set -euo pipefail

TARGET=${AGENT_FLEET_SERVER:-bochao_li@10.0.60.98}
HERE=$(cd "$(dirname "$0")/.." && pwd)
REMOTE_DIR=/home/bochao_li/agent-fleet/dsh-agent-fleet
NODE=/usr/local/bin/node
LOCAL_NODE=${AGENT_FLEET_NODE:-node} # builds the collector bundle here; needs Node ≥ 22.15
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET")
PANEL_UNIT=trta-v4-panel-http443.service
# Extra session roots on the server (TRTA v4 analysis containers: DSH in podman, OMP for Argon), read by the hub
# unit from ~/.config/agent-fleet/hub.env as AGENT_FLEET_ROOTS (kind=glob pairs, colon separated).
HUB_ENV="AGENT_FLEET_ROOTS=dsh=/data/task-telemetry-20261029/v4/runs/*/work/harness-home/sessions:omp=/data/task-telemetry-20261029/v4/argon/*/work/sessions"
# sg-compute: agents run with isolated homes under ~/agent-fleet/homes (see the provisioning notes); node from tools/.
SG_TARGET=${AGENT_FLEET_SG:-sg-compute}
SG_ROOT=/ch/home/bochao_li/agent-fleet
SG_NODE=$SG_ROOT/tools/node/bin/node
SG_ROOTS="--root claude=$SG_ROOT/homes/claude/projects --root codex=$SG_ROOT/homes/codex/sessions --root omp=$SG_ROOT/homes/omp/agent/sessions --root dsh=$SG_ROOT/homes/dsh/sessions"
SG_SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$SG_TARGET")

render() { # template → stdout; server values unless UNIT_DIR / UNIT_NODE / UNIT_HOST / UNIT_SITE / UNIT_ROOTS override them
  sed -e "s#@@F@@#${UNIT_DIR:-$REMOTE_DIR}#g" -e "s#@@NODE@@#${UNIT_NODE:-$NODE}#g" -e "s#@@DSH@@#/home/bochao_li/agent-fleet/bin/dsh#g" \
    -e "s#@@HOST@@#${UNIT_HOST:-}#g" -e "s#@@SITE@@#${UNIT_SITE:-}#g" -e "s#@@ROOTS@@#${UNIT_ROOTS:-}#g" "$1"
}

case "${1:-}" in
  sync)
    (cd "$HERE" && "$LOCAL_NODE" tools/build-collector.mjs >/dev/null)
    rsync -a --delete --exclude .scratch --exclude node_modules --exclude tests \
      -e "ssh -o BatchMode=yes" "$HERE/" "$TARGET:$REMOTE_DIR/"
    "${SSH[@]}" "cd $REMOTE_DIR && $NODE --version && ls dist/agent-fleet-collector.mjs"
    ;;
  sg)
    (cd "$HERE" && "$LOCAL_NODE" tools/build-collector.mjs >/dev/null)
    # The collector authenticates to the hub's ingest port with the hub's own 0600 token. The hub creates it on its
    # first start with --ingest-token-file; copy it over stdin (never echoed, never in argv) and keep 0600 over there.
    "${SSH[@]}" 'test -s ~/.config/agent-fleet/ingest-token' ||
      { echo "deploy-server.sh: ~/.config/agent-fleet/ingest-token does not exist on the server yet; run 'deploy-server.sh units' first" >&2; exit 1; }
    "${SSH[@]}" 'cat ~/.config/agent-fleet/ingest-token' |
      "${SG_SSH[@]}" 'umask 077; mkdir -p ~/.config/agent-fleet; cat > ~/.config/agent-fleet/ingest-token; chmod 600 ~/.config/agent-fleet/ingest-token'
    # sg-compute has no rsync: unpack into a fresh directory, then swap it in (same effect as rsync --delete).
    COPYFILE_DISABLE=1 tar -C "$HERE" --no-xattrs --exclude ./.scratch --exclude ./node_modules --exclude ./tests -cf - . |
      "${SG_SSH[@]}" "set -e; D=$SG_ROOT/dsh-agent-fleet; rm -rf \$D.new \$D.old; mkdir -p \$D.new; tar -xf - -C \$D.new; if [ -d \$D ]; then mv \$D \$D.old; fi; mv \$D.new \$D; rm -rf \$D.old"
    UNIT_DIR=$SG_ROOT/dsh-agent-fleet UNIT_NODE=$SG_NODE UNIT_HOST=sg-compute UNIT_SITE=sg-compute UNIT_ROOTS="$SG_ROOTS" render "$HERE/deploy/systemd/agent-fleet-collector.service" |
      "${SG_SSH[@]}" "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/agent-fleet-collector.service"
    "${SG_SSH[@]}" 'systemctl --user daemon-reload && systemctl --user enable agent-fleet-collector.service && systemctl --user restart agent-fleet-collector.service && sleep 3 && systemctl --user --no-pager --lines=0 status agent-fleet-collector.service | grep -E "Loaded|Active"'
    ;;
  units)
    printf '%s\n' "$HUB_ENV" | "${SSH[@]}" 'umask 077; mkdir -p ~/.config/agent-fleet && cat > ~/.config/agent-fleet/hub.env'
    for unit in agent-fleet-hub dsh-web; do
      render "$HERE/deploy/systemd/$unit.service" | "${SSH[@]}" "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/$unit.service"
    done
    "${SSH[@]}" 'systemctl --user daemon-reload && systemctl --user enable agent-fleet-hub.service dsh-web.service && systemctl --user restart agent-fleet-hub.service dsh-web.service && sleep 3 && systemctl --user --no-pager --lines=0 status agent-fleet-hub.service dsh-web.service | grep -E "Loaded|Active"'
    ;;
  edge-test)
    "${SSH[@]}" "timeout 20 $NODE $REMOTE_DIR/bin/agent-fleet.mjs edge --listen 127.0.0.1:7849 --route /fleet=http://127.0.0.1:7840 --route /dsh=http://127.0.0.1:3080 --fallback http://10.0.60.98:443 >/tmp/agent-fleet-edge-test.log 2>&1 & sleep 1.5;
      for p in /fleet/api/health /dsh/ / ; do printf '%s %s\n' \"\$p\" \"\$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:7849\$p)\"; done; kill %1 2>/dev/null || true; rm -f /tmp/agent-fleet-edge-test.log"
    ;;
  cutover)
    render "$HERE/deploy/systemd/agent-fleet-edge.service" | "${SSH[@]}" "sudo tee /etc/systemd/system/agent-fleet-edge.service >/dev/null"
    "${SSH[@]}" "sudo mkdir -p /etc/systemd/system/${PANEL_UNIT}.d" 
    "${SSH[@]}" "sudo tee /etc/systemd/system/${PANEL_UNIT}.d/10-agent-fleet-edge.conf >/dev/null" < "$HERE/deploy/systemd/trta-v4-panel-http443.service.d/10-agent-fleet-edge.conf"
    "${SSH[@]}" "set -e; sudo systemctl daemon-reload; sudo systemctl restart ${PANEL_UNIT}; sudo systemctl enable --now agent-fleet-edge.service;
      for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null -m 2 http://10.0.60.98:443/ && break; sleep 0.5; done;
      sudo ss -ltnpH 'sport = :443 or sport = :8464'"
    ;;
  rollback)
    "${SSH[@]}" "sudo systemctl disable --now agent-fleet-edge.service || true; sudo rm -f /etc/systemd/system/${PANEL_UNIT}.d/10-agent-fleet-edge.conf; sudo systemctl daemon-reload; sudo systemctl restart ${PANEL_UNIT}; sudo ss -ltnpH 'sport = :443'"
    ;;
  status)
    "${SSH[@]}" "systemctl --user --no-pager --lines=0 status agent-fleet-hub.service dsh-web.service 2>&1 | grep -E '●|Active'; systemctl --no-pager --lines=0 status agent-fleet-edge.service ${PANEL_UNIT} 2>&1 | grep -E '●|Active';
      for u in http://127.0.0.1:7840/api/health http://127.0.0.1:3080/ http://127.0.0.1:8464/ http://10.0.60.98:443/fleet/api/health http://10.0.60.98:443/; do printf '%s %s\n' \"\$u\" \"\$(curl -s -o /dev/null -m 5 -w '%{http_code}' \$u)\"; done"
    "${SG_SSH[@]}" "systemctl --user --no-pager --lines=0 status agent-fleet-collector.service 2>&1 | grep -E '●|Active'" || true
    ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
