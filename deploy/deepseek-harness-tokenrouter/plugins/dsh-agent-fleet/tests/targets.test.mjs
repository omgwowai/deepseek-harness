// lib/targets.mjs: shell parsing, kubectl / ssh / scp recognition, native tool classification, previews, caps.
// Fixtures are synthetic; names and addresses model the real fleet (pods in mc-bochao-li, 10.0.60.98, sg-compute).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTool, parseCommand } from "../lib/targets.mjs";
import { LIMITS, NAMESPACE, TOOL_CATEGORIES, TARGET_TYPES, podHostId } from "../lib/protocol.mjs";

const MAC = { host: "mac", site: "mac", cwd: "/Users/me/work", home: "/Users/me" };
const parse = (cmd, opts = {}) => parseCommand(cmd, { ...MAC, ...opts });
const tool = (name, input, kind = "claude", opts = {}) => classifyTool({ kind, name, input, ...MAC, ...opts });
const ofType = (r, type) => r.targets.filter(t => t.type === type);
const files = r => ofType(r, "file").map(t => `${t.op}:${t.host}:${t.path}`);

const WRAPPER = "python3 ~/.codex/skills/github-cluster-access/scripts/access.py kubectl";

test("access.py wrapper: kubectl exec into a pod of the osmium cluster", () => {
  const r = parse(`${WRAPPER} ulanqab-osmium -- exec -n mc-bochao-li botato-workspace-668b44c86d-xgtc5 -c workspace -- node -e 'require("fs").readFileSync("/data/not-a-target.json")'`);
  assert.equal(r.category, "k8s");
  assert.deepEqual(r.targets, [{
    type: "pod", op: "exec", site: "os", cluster: "ulanqab-osmium", namespace: "mc-bochao-li",
    name: "botato-workspace-668b44c86d-xgtc5", container: "workspace",
  }]); // paths inside `node -e` code are code, not files
});

test("access.py wrapper: cluster aliases map to sites, unknown clusters keep site null", () => {
  assert.equal(parse(`${WRAPPER} jiaqi-b300 -- get pods -n mc-bochao-li`).targets[0].site, "iron");
  const ali = parse(`${WRAPPER} ali -- logs -n mc-bochao-li some-pod`).targets[0];
  assert.deepEqual([ali.type, ali.op, ali.site, ali.cluster, ali.name], ["pod", "logs", null, "ali", "some-pod"]);
});

test("access.py wrapper with env prefix, -B and flags before the verb", () => {
  const r = parse(`env PYTHONDONTWRITEBYTECODE=1 python3 -B ~/.codex/skills/github-cluster-access/scripts/access.py kubectl ulanqab-iron -- -n mc-bochao-li --request-timeout=25s exec iron-pod-1 -- nvidia-smi`);
  assert.deepEqual(ofType(r, "pod").map(t => [t.op, t.site, t.name]), [["exec", "iron", "iron-pod-1"]]);
});

test("ssh with options: remote files carry the site id, remote agent launch carries the site", () => {
  const r = parse(`ssh -o BatchMode=yes bochao_li@10.0.60.98 'cat /data/x.log; omp -p hi'`);
  assert.deepEqual(r.targets, [
    { type: "host", op: "ssh", host: "bochao_li@10.0.60.98", site: "server-bochao-01" },
    { type: "file", op: "read", host: "server-bochao-01", path: "/data/x.log" },
    { type: "agent", op: "launch", kind: "omp", site: "server-bochao-01", transport: "cli" },
  ]);
  assert.equal(r.category, "spawn");
});

test("ssh to a host outside the fleet reports the raw target; -p/-i/-J values are not the destination", () => {
  const r = parse(`ssh -p 2222 -i ~/.ssh/key -J jump.example.com deploy@build-7 'ls /srv/app'`);
  assert.deepEqual(ofType(r, "host"), [{ type: "host", op: "ssh", host: "deploy@build-7", site: null }]);
  assert.deepEqual(files(r), ["list:deploy@build-7:/srv/app"]);
  assert.equal(r.category, "remote");
});

test("ssh -G prints configuration and does not touch the host", () => {
  assert.deepEqual(parse("ssh -G sg-compute | rg '^hostname '").targets, []);
});

test("ssh: remote cwd starts at the remote home, cd moves it, local cwd never leaks", () => {
  const r = parse(`ssh sg-compute 'cat notes.md && cd /srv/app && cat run.sh'`);
  assert.deepEqual(files(r), ["read:sg-compute:~/notes.md", "read:sg-compute:/srv/app/run.sh"]);
});

test("ssh remote script on stdin (bash -s heredoc) is parsed as remote commands", () => {
  const r = parse("ssh sg-compute 'bash -s' <<'SH'\ncd /srv && cat app.log\nSH");
  assert.deepEqual(files(r), ["read:sg-compute:/srv/app.log"]);
});

test("ssh remote python heredoc is code, not shell", () => {
  const r = parse("ssh sg-compute 'python3 -' <<'PY'\nimport os\nos.system('rm -rf /data')\nPY");
  assert.deepEqual(r.targets.map(t => t.type), ["host"]);
});

test("kubectl --context=X -n NS logs -f pod/NAME -c C", () => {
  const r = parse("kubectl --context=chengdu -n mc-bochao-li logs -f pod/foo-1 -c main");
  assert.deepEqual(r.targets, [{ type: "pod", op: "logs", site: "chengdu", cluster: "chengdu", namespace: "mc-bochao-li", name: "foo-1", container: "main" }]);
  assert.equal(r.category, "k8s");
});

test("kubectl defaults to the fleet namespace for fleet clusters, not for unknown ones", () => {
  assert.equal(parse("kubectl --context weihai get pod web-1").targets[0].namespace, NAMESPACE);
  assert.equal(parse("kubectl --context other-cluster get pod web-1").targets[0].namespace, undefined);
  assert.equal(parse("kubectl --context weihai -A get pods").targets[0].namespace, undefined);
});

test("kubectl without a context: site null, still a pod target", () => {
  const t = parse("kubectl exec -it web-1 -- ls").targets[0];
  assert.deepEqual([t.type, t.op, t.site, t.name], ["pod", "exec", null, "web-1"]);
});

test("kubectl verbs on other resources become k8s targets", () => {
  const k = cmd => parse(`kubectl --context ulanqab-iron -n mc-bochao-li ${cmd}`).targets.map(t => [t.type, t.op, t.resource, t.name]);
  assert.deepEqual(k("rollout restart deploy/api"), [["k8s", "rollout", "deployment", "api"]]);
  assert.deepEqual(k("scale --replicas=0 deployment worker"), [["k8s", "scale", "deployment", "worker"]]);
  assert.deepEqual(k("get svc,deploy"), [["k8s", "get", "service", undefined], ["k8s", "get", "deployment", undefined]]);
  assert.deepEqual(k("delete pod a b"), [["pod", "delete", undefined, "a"], ["pod", "delete", undefined, "b"]]);
  assert.deepEqual(k("describe node gpu-07"), [["k8s", "describe", "node", "gpu-07"]]);
  assert.deepEqual(k("cordon gpu-07"), [["k8s", "cordon", "node", "gpu-07"]]);
  assert.deepEqual(k("get pods -l app=x"), [["k8s", "get", "pod", undefined]]);
});

test("kubectl label selectors are reported as `selector`, never as a name", () => {
  const sel = parse("kubectl --context chengdu logs -l app=web --tail=5").targets;
  assert.deepEqual(sel, [{ type: "k8s", op: "logs", site: "chengdu", cluster: "chengdu", namespace: "mc-bochao-li", resource: "pod", selector: "app=web" }]);
  const del = parse("kubectl --context chengdu delete pods --selector tier=cache").targets;
  assert.deepEqual(del.map(t => [t.type, t.resource, t.name, t.selector]), [["k8s", "pod", undefined, "tier=cache"]]);
  // exec in "some pod matching the selector" cannot name a pod host, so its files are dropped
  assert.deepEqual(files(parse("kubectl --context chengdu exec -l app=web -- cat /etc/hosts")), []);
});

test("for loops over literal lists run the body once per value", () => {
  const r = parse(`for p in /AGENTS.md /Users/AGENTS.md; do if [ -f "$p" ]; then sed -n '1,40p' "$p"; fi; done; cat /after`);
  assert.deepEqual(files(r), ["read:mac:/AGENTS.md", "read:mac:/Users/AGENTS.md", "read:mac:/after"]);
  const nested = parse("for c in chengdu weihai; do for n in a b; do kubectl --context $c get pod $n; done; done");
  assert.deepEqual(nested.targets.map(t => `${t.site}/${t.name}`), ["chengdu/a", "chengdu/b", "weihai/a", "weihai/b"]);
  assert.deepEqual(files(parse("for f in $(ls); do cat $f; done; cat /after")), ["read:mac:/after"]); // values unknown
  assert.deepEqual(files(parse(`for f in a b c d e f g; do cat /d/$f; done`)).length, 4); // bounded
  assert.deepEqual(files(parse("while read -r f; do cat \"$f\"; done < /list.txt; cat /after")), ["read:mac:/list.txt", "read:mac:/after"]);
});

test("kubectl label/annotate: key=value arguments are not objects", () => {
  const r = parse("kubectl --context chengdu label pod web-1 tier=front -n mc-bochao-li");
  assert.deepEqual(r.targets.map(t => [t.type, t.op, t.name]), [["pod", "apply", "web-1"]]);
});

test("kubectl exec: files read inside the pod live on the pod host", () => {
  const r = parse("kubectl --context ulanqab-osmium -n mc-bochao-li exec pod-9 -c main -- sh -c 'cd /work && cat logs/run.log'");
  assert.deepEqual(files(r), [`read:${podHostId("os", "pod-9")}:/work/logs/run.log`]);
});

test("kubectl exec into a deployment: no host id, so no file targets; the agent still launches on the site", () => {
  const r = parse("kubectl --context chengdu exec deploy/api -- bash -lc 'cat /etc/hosts; claude -p hi'");
  assert.deepEqual(files(r), []);
  assert.deepEqual(ofType(r, "agent"), [{ type: "agent", op: "launch", kind: "claude", site: "chengdu", transport: "cli" }]);
  assert.deepEqual(ofType(r, "k8s").map(t => [t.resource, t.name]), [["deployment", "api"]]);
});

test("kubectl exec launching an agent inside a pod", () => {
  const r = parse("kubectl --context=ulanqab-osmium -n mc-bochao-li exec -i pod-3 -- bun /root/.bun/bin/omp --session /tmp/s.jsonl");
  assert.deepEqual(ofType(r, "agent"), [{ type: "agent", op: "launch", kind: "omp", site: "os", pod: "pod-3", transport: "cli" }]);
  assert.equal(r.category, "spawn");
  for (const [cmd, kind] of [["claude -p x", "claude"], ["codex exec y", "codex"], ["node /opt/dsh/lib/bin.js web", "dsh"], ["dsh run", "dsh"]]) {
    assert.equal(parse(`kubectl --context weihai exec p1 -- ${cmd}`).targets.find(t => t.type === "agent")?.kind, kind, cmd);
  }
});

test("kubectl cp: pod side on the pod host, local side on the local host", () => {
  const r = parse("kubectl --context ulanqab-iron cp mc-bochao-li/pod-1:/tmp/out.json ./out.json -c main");
  assert.deepEqual(r.targets, [
    { type: "pod", op: "cp", site: "iron", cluster: "ulanqab-iron", namespace: "mc-bochao-li", name: "pod-1", container: "main" },
    { type: "file", op: "read", host: "k8s/iron/pod-1", path: "/tmp/out.json" },
    { type: "file", op: "write", host: "mac", path: "/Users/me/work/out.json" },
  ]);
  const up = parse("kubectl --context chengdu cp /tmp/a.py pod-2:/work/a.py");
  assert.deepEqual(files(up), ["write:k8s/chengdu/pod-2:/work/a.py", "read:mac:/tmp/a.py"]);
});

test("kubectl apply -f - with a manifest heredoc names the object", () => {
  const r = parse("kubectl --context chengdu apply -f - <<'EOF'\napiVersion: v1\nkind: Pod\nmetadata:\n  name: probe-1\n  namespace: mc-bochao-li\nspec:\n  containers: []\nEOF");
  assert.deepEqual(r.targets.map(t => [t.type, t.op, t.name, t.namespace]), [["pod", "apply", "probe-1", "mc-bochao-li"]]);
});

test("kubectl apply -f file reads the manifest from the local host", () => {
  const r = parse("kubectl --context chengdu apply -f deploy/pod.yaml");
  assert.deepEqual(files(r), ["read:mac:/Users/me/work/deploy/pod.yaml"]);
  assert.equal(ofType(r, "k8s").length, 1);
});

test("kubectl config/version do not produce targets but are still k8s commands", () => {
  const r = parse("kubectl config get-contexts -o name");
  assert.deepEqual(r.targets, []);
  assert.equal(r.category, "k8s");
});

test("shell wrapper: bash -lc 'cd X && sed -n … > file'", () => {
  const r = parse("bash -lc 'cd /work && sed -n 1,20p src/a.ts > /tmp/out.txt'");
  assert.deepEqual(files(r), ["read:mac:/work/src/a.ts", "write:mac:/tmp/out.txt"]);
  assert.equal(r.category, "shell");
});

test("sudo / env / timeout / nohup / time wrappers are transparent", () => {
  assert.deepEqual(files(parse("sudo -u deploy env A=B timeout 30 nohup time cat /etc/passwd")), ["read:mac:/etc/passwd"]);
  assert.deepEqual(files(parse("FOO=bar BAR=baz tail -n 5 app.log")), ["read:mac:/Users/me/work/app.log"]);
});

test("operators and quotes: separators inside quotes are text, commands after &&, ||, ;, | are parsed", () => {
  assert.deepEqual(files(parse(`echo "a && cat /no/such" ; cat /yes/one && cat /yes/two || cat /yes/three | wc -l /yes/four`)),
    ["read:mac:/yes/one", "read:mac:/yes/two", "read:mac:/yes/three", "read:mac:/yes/four"]);
  assert.deepEqual(files(parse("grep -n 'a|b;c' src/x.js\ncat /second/line")), ["search:mac:/Users/me/work/src/x.js", "read:mac:/second/line"]);
});

test("cd tracking: subshell cwd does not leak, cd .. works, unknown cwd drops relative paths", () => {
  assert.deepEqual(files(parse("(cd /sub && cat x.txt); cat y.txt")), ["read:mac:/sub/x.txt", "read:mac:/Users/me/work/y.txt"]);
  assert.deepEqual(files(parse("cd /a/b && cat c.txt; cd .. && cat d.txt")), ["read:mac:/a/b/c.txt", "read:mac:/a/d.txt"]);
  assert.deepEqual(files(parse("cd \"$(mktemp -d)\" && cat out.txt && cat /abs.txt")), ["read:mac:/abs.txt"]);
  assert.deepEqual(files(parse("cat rel.txt", { cwd: undefined })), []);
});

test("variables: assignments feed later commands; bare $VAR expands into words", () => {
  const r = parse(`K="kubectl --context weihai -n mc-bochao-li"; F=/data/a.log; $K exec pod-1 -- cat $F`);
  assert.deepEqual(ofType(r, "pod").map(t => [t.op, t.site, t.name]), [["exec", "weihai", "pod-1"]]);
  assert.deepEqual(files(r), ["read:k8s/weihai/pod-1:/data/a.log"]);
  assert.deepEqual(files(parse("cat $UNSET/file.txt ~/notes.md")), ["read:mac:/Users/me/notes.md"]);
});

test("heredoc bodies are not commands", () => {
  const r = parse("cat > /tmp/a.py <<'EOF'\nkubectl --context chengdu delete pod prod-1\nrm -rf /important\nssh sg-compute reboot\nEOF\npython3 /tmp/a.py");
  assert.deepEqual(r.targets, [
    { type: "file", op: "write", host: "mac", path: "/tmp/a.py" },
    { type: "file", op: "exec", host: "mac", path: "/tmp/a.py" },
  ]);
  assert.equal(r.category, "shell");
});

test("heredoc variants: <<-, quoted and unquoted delimiters, two heredocs, here-string", () => {
  assert.deepEqual(files(parse("cat <<-EOT > /tmp/x\n\tcat /body/one\n\tEOT\ncat /after")), ["write:mac:/tmp/x", "read:mac:/after"]);
  assert.deepEqual(files(parse("cat <<A >/tmp/p; cat <<B >/tmp/q\ncat /in/a\nA\ncat /in/b\nB\ncat /end")), ["write:mac:/tmp/p", "write:mac:/tmp/q", "read:mac:/end"]);
  assert.deepEqual(files(parse("python3 - <<<'cat /not/a/file'")), []);
});

test("bash -s with a heredoc runs the body as shell", () => {
  assert.deepEqual(files(parse("bash -s <<'SH'\ncat /body/file\nSH")), ["read:mac:/body/file"]);
});

test("redirections: > >> < &> and fd forms; /dev and fd duplication are not files", () => {
  assert.deepEqual(files(parse("make > build.log 2>&1 < /in/data 2>/dev/null >> /var/log/x.log")),
    ["write:mac:/Users/me/work/build.log", "read:mac:/in/data", "write:mac:/var/log/x.log"]);
  assert.deepEqual(files(parse("cmd &> all.log")), ["write:mac:/Users/me/work/all.log"]);
});

test("file commands: ops by command", () => {
  assert.deepEqual(files(parse("head -n 5 /a /b")), ["read:mac:/a", "read:mac:/b"]);
  assert.deepEqual(files(parse("tail -f -n 20 /var/log/x.log")), ["read:mac:/var/log/x.log"]);
  const all = files(parse("touch /t1; mkdir -p /m1; rm -rf /r1 /r2; rmdir /d1; chmod 600 /c1; ln -s /target /link; tee -a /tee1 < /x"));
  assert.deepEqual(all, ["write:mac:/t1", "write:mac:/m1", "delete:mac:/r1", "delete:mac:/r2", "delete:mac:/d1", "edit:mac:/c1", "write:mac:/link", "write:mac:/tee1", "read:mac:/x"]);
});

test("~ resolves against home: explicit, derived from cwd, or kept literal", () => {
  assert.deepEqual(files(parseCommand("cat ~/a.txt", { host: "h", cwd: "/tmp", home: "/Users/me" })), ["read:h:/Users/me/a.txt"]);
  assert.deepEqual(files(parseCommand("cat ~/a.txt", { host: "h", cwd: "/home/u/proj" })), ["read:h:/home/u/a.txt"]);
  assert.deepEqual(files(parseCommand("cat ~/a.txt $HOME/b.txt", { host: "h", cwd: "/data/x" })), ["read:h:~/a.txt", "read:h:~/b.txt"]);
  assert.deepEqual(files(parseCommand("cat ~other/a.txt", { host: "h", cwd: "/home/u" })), []);
});

test("process command lines: relay, hub-launched collector, remote agents", () => {
  const relay = parseCommand("ssh -W 127.0.0.1:7841 bochao_li@10.0.60.98", MAC);
  assert.deepEqual(relay.targets, [{ type: "host", op: "ssh", host: "bochao_li@10.0.60.98", site: "server-bochao-01" }]);
  assert.equal(relay.category, "remote");
  const collector = parseCommand("kubectl --kubeconfig /x/kubeconfig.yaml --context ulanqab-osmium -n mc-bochao-li exec -i pod-1 -- node /tmp/agent-fleet-collector.mjs --stdio --host-id k8s/os/pod-1 --site os", MAC);
  assert.deepEqual(collector.targets.map(t => `${t.type}:${t.op}:${t.host ?? t.name}`), ["pod:exec:pod-1", "file:exec:k8s/os/pod-1"]);
  const remoteAgent = parseCommand("ssh -tt sg-compute omp --session /tmp/s.jsonl", MAC);
  assert.deepEqual(remoteAgent.targets.map(t => `${t.type}:${t.site}`), ["host:sg-compute", "agent:sg-compute"]);
});

test("cp / mv / install: sources read (mv: delete), destination written, directory targets receive basenames", () => {
  assert.deepEqual(files(parse("cp -r src/lib /backup/")), ["read:mac:/Users/me/work/src/lib", "write:mac:/backup/lib"]);
  assert.deepEqual(files(parse("mv a.txt b.txt")), ["delete:mac:/Users/me/work/a.txt", "write:mac:/Users/me/work/b.txt"]);
  assert.deepEqual(files(parse("cp -t /dst /s1 /s2")), ["read:mac:/s1", "read:mac:/s2", "write:mac:/dst/s1", "write:mac:/dst/s2"]);
});

test("sed / awk / grep / rg / jq / diff / wc: patterns and scripts are not files", () => {
  assert.deepEqual(files(parse("sed -n '1,20p' src/a.ts")), ["read:mac:/Users/me/work/src/a.ts"]);
  assert.deepEqual(files(parse("sed -i '' 's/a/b/' src/a.ts src/b.ts")), ["edit:mac:/Users/me/work/src/a.ts", "edit:mac:/Users/me/work/src/b.ts"]);
  assert.deepEqual(files(parse("sed -i.bak -e 's/x/y/' conf.ini")), ["edit:mac:/Users/me/work/conf.ini"]);
  assert.deepEqual(files(parse("awk -F, '{print $1}' data.csv")), ["read:mac:/Users/me/work/data.csv"]);
  assert.deepEqual(files(parse("grep -rn 'TODO|FIXME' src tests")), ["search:mac:/Users/me/work/src", "search:mac:/Users/me/work/tests"]);
  assert.deepEqual(files(parse("rg -n -g '*.ts' pattern lib/")), ["search:mac:/Users/me/work/lib"]);
  assert.deepEqual(files(parse("rg --files src")), ["search:mac:/Users/me/work/src"]);
  assert.deepEqual(files(parse("jq -r '.items[] | .name' out.json")), ["read:mac:/Users/me/work/out.json"]);
  assert.deepEqual(files(parse("diff -u old.txt new.txt")), ["read:mac:/Users/me/work/old.txt", "read:mac:/Users/me/work/new.txt"]);
  assert.deepEqual(files(parse("wc -l < in.txt")), ["read:mac:/Users/me/work/in.txt"]);
  assert.deepEqual(files(parse("ls -la")), []);
});

test("interpreters: scripts are exec targets, inline code and modules are not", () => {
  assert.deepEqual(files(parse("python3 -B tools/build.py --flag")), ["exec:mac:/Users/me/work/tools/build.py"]);
  assert.deepEqual(files(parse("node --max-old-space-size=4096 scripts/run.mjs")), ["exec:mac:/Users/me/work/scripts/run.mjs"]);
  assert.deepEqual(files(parse(`node -e 'console.log(require("/etc/passwd"))'`)), []);
  assert.deepEqual(files(parse("python3 -m pytest tests/x.py")), []);
  assert.deepEqual(files(parse("python3 - <<'PY'\nprint(open('/etc/hosts').read())\nPY")), []);
  assert.deepEqual(files(parse("bun run build")), []);
  assert.deepEqual(files(parse("perl -pi -e 's/a/b/' src/a.js")), ["edit:mac:/Users/me/work/src/a.js"]);
  assert.deepEqual(files(parse("perl -ne 'print if /x/' data.txt")), ["read:mac:/Users/me/work/data.txt"]);
  assert.deepEqual(files(parse("sqlite3 -readonly /var/db/agent.db '.tables'")), ["read:mac:/var/db/agent.db"]);
  assert.deepEqual(files(parse("sqlite3 app.db 'delete from t'")), ["edit:mac:/Users/me/work/app.db"]);
  assert.deepEqual(files(parse("./deploy.sh && source ~/.profile")), ["exec:mac:/Users/me/work/deploy.sh", "exec:mac:/Users/me/.profile"]);
});

test("chmod/chown: the mode or owner is not a file, '-x' is a mode", () => {
  assert.deepEqual(files(parse("chmod -x script.sh; chmod +x run.sh; chown -R me:me /srv/app")),
    ["edit:mac:/Users/me/work/script.sh", "edit:mac:/Users/me/work/run.sh", "edit:mac:/srv/app"]);
});

test("brace expansion and globs", () => {
  assert.deepEqual(files(parse("cat /etc/{hosts,hostname}")), ["read:mac:/etc/hosts", "read:mac:/etc/hostname"]);
  assert.deepEqual(files(parse("rm -f build/*.o")), ["delete:mac:/Users/me/work/build/*.o"]);
});

test("xargs placeholders are not files", () => {
  assert.deepEqual(files(parse("find . -name '*.tmp' | xargs -I{} cp {} /backup/")), ["search:mac:/Users/me/work"]);
});

test("scp and rsync: remote operands resolve to hosts, local ones to the local host", () => {
  const up = parse("scp -P 22 -i ~/.ssh/id_ed25519 ./a.txt bochao_li@10.0.60.98:/data/a.txt");
  assert.deepEqual(up.targets, [
    { type: "file", op: "read", host: "mac", path: "/Users/me/work/a.txt" },
    { type: "host", op: "scp", host: "bochao_li@10.0.60.98", site: "server-bochao-01" },
    { type: "file", op: "write", host: "server-bochao-01", path: "/data/a.txt" },
  ]);
  assert.equal(up.category, "remote");
  const down = parse("scp sg-compute:/var/log/x.log /tmp/");
  assert.deepEqual(files(down), ["read:sg-compute:/var/log/x.log", "write:mac:/tmp"]);
  const rs = parse("rsync -avz --exclude node_modules -e 'ssh -p 22' ./dist/ sg-compute:/srv/dist/");
  assert.deepEqual(rs.targets.map(t => t.type === "file" ? `${t.op}:${t.host}:${t.path}` : `${t.type}:${t.op}:${t.host}`),
    ["read:mac:/Users/me/work/dist", "host:rsync:sg-compute", "write:sg-compute:/srv/dist"]);
  assert.deepEqual(files(parse("scp sg-compute:logs/a.log .")), ["read:sg-compute:~/logs/a.log", "write:mac:/Users/me/work"]);
});

test("tar: archive and members by mode", () => {
  assert.deepEqual(files(parse("tar czf /tmp/out.tgz -C /srv app conf")), ["write:mac:/tmp/out.tgz", "read:mac:/srv/app", "read:mac:/srv/conf"]);
  assert.deepEqual(files(parse("tar xzf /tmp/in.tgz -C /restore")), ["read:mac:/tmp/in.tgz", "write:mac:/restore"]);
  assert.deepEqual(files(parse("tar czf - -C /srv app | ssh sg-compute 'tar xzf - -C /backup'")),
    ["read:mac:/srv/app", "write:sg-compute:/backup"]);
});

test("urls: curl/wget/git remotes; credentials in URLs are redacted; -o writes", () => {
  const r = parse("curl -fsSL -H 'X-Trace: 1' -o /tmp/x.sh https://get.example.com/x.sh && git clone https://user:hunter2hunter2@github.com/o/r.git");
  assert.deepEqual(ofType(r, "url").map(t => t.url), ["https://get.example.com/x.sh", "https://user:‹redacted›@github.com/o/r.git"]);
  assert.deepEqual(files(r), ["write:mac:/tmp/x.sh"]);
  assert.deepEqual(ofType(parse("git fetch git@github.com:owner/repo.git"), "url").map(t => t.url), ["git@github.com:owner/repo.git"]);
  assert.deepEqual(parse("git status && git diff --stat").targets, []);
  assert.deepEqual(files(parse("curl -X POST -d @payload.json https://api.example.com/v1")), ["read:mac:/Users/me/work/payload.json"]);
});

test("agent launches: omp, claude, codex, dsh, ACP bridges; non-session subcommands and --version are not launches", () => {
  const kinds = cmd => ofType(parse(cmd), "agent").map(t => `${t.kind}/${t.transport}`);
  assert.deepEqual(kinds("omp -p 'summarize'"), ["omp/cli"]);
  assert.deepEqual(kinds("bun ~/.bun/bin/omp --session /tmp/s.jsonl"), ["omp/cli"]);
  assert.deepEqual(kinds("bun /g/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js -p hi"), ["omp/cli"]);
  assert.deepEqual(kinds("claude -p review && codex exec fix"), ["claude/cli", "codex/cli"]);
  assert.deepEqual(kinds("npx -y @anthropic-ai/claude-code -p hi"), ["claude/cli"]);
  assert.deepEqual(kinds("node ~/.local/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web"), ["dsh/cli"]);
  assert.deepEqual(kinds("claude-agent-acp"), ["claude/acp"]);
  assert.deepEqual(kinds("codex-acp"), ["codex/acp"]);
  assert.deepEqual(kinds("omp acp"), ["omp/acp"]);
  assert.deepEqual(kinds("omp --version; codex --help; claude mcp list; command -v omp; which codex; pgrep -f claude"), []);
  // Regression: `dsh ... --dump-config` prints configuration and exits, so it launches no session — a command link
  // built on it attached an unrelated DSH session that started within the window (ServerAcp3's DSH Web run).
  assert.deepEqual(kinds("dsh --profile web --dump-config; dsh --dump-default-config; dsh --dump-config-schema"), []);
  assert.deepEqual(kinds("dsh --profile web plugin add @local/x; dsh plugin --profile tui add y"), []);
  assert.deepEqual(kinds("dsh --profile headless 'Do the task'"), ["dsh/cli"]);
  assert.deepEqual(kinds("dsh --profile headless --patch ./p.yml 'Do the task'"), ["dsh/cli"]);
  assert.equal(parse("timeout 60 env HOME=/x claude -p hi").category, "spawn");
});

test("argv arrays (process command lines, codex `shell`) parse like shell text", () => {
  const r = parseCommand(["bash", "-lc", "cd /w && cat a.txt; omp -p hi"], MAC);
  assert.deepEqual(r.targets.map(t => t.type), ["file", "agent"]);
  assert.deepEqual(parseCommand(["kubectl", "exec", "pod-1", "--context", "chengdu", "--", "omp", "-p", "x"], MAC).targets.map(t => `${t.type}:${t.name ?? t.kind}`),
    ["pod:pod-1", "agent:omp"]);
});

test("parseCommand never throws and tolerates garbage", () => {
  for (const bad of [undefined, null, "", "   ", "'unterminated", '"also', "$(((", "`", "(((((((((((((", "cat <<EOF", "\0\0", 42, {}, [], ["kubectl"]]) {
    const r = parseCommand(bad, MAC);
    assert.ok(TOOL_CATEGORIES.includes(r.category));
    assert.ok(Array.isArray(r.targets));
  }
  const deep = "$(".repeat(5000) + "cat /x" + ")".repeat(5000);
  assert.ok(Array.isArray(parseCommand(deep, MAC).targets));
  assert.ok(Array.isArray(parseCommand("bash -c '".repeat(40) + "cat /x" + "'".repeat(40), MAC).targets));
});

test("parseCommand stays fast on a 200 KB command", () => {
  const big = "echo hello world; ".repeat(10000) + "cat /tail/file";
  const t0 = performance.now();
  const r = parseCommand(big, MAC);
  assert.ok(performance.now() - t0 < 1500);
  assert.deepEqual(files(r), ["read:mac:/tail/file"]);
});

test("nested loops cannot multiply the work", () => {
  const cmd = "for a in 1 2 3 4; do ".repeat(40) + "cat /x$a; " + "done; ".repeat(40);
  const t0 = performance.now();
  const r = parse(cmd);
  assert.ok(performance.now() - t0 < 1500, "analysis must be budgeted");
  assert.ok(files(r).includes("read:mac:/x1"));
  const t1 = performance.now();
  const wrappers = parse("for a in 1 2 3 4; do ".repeat(12) + `bash -c 'bash -c "cat /y"'; ` + "done; ".repeat(12));
  assert.ok(performance.now() - t1 < 1500);
  assert.ok(files(wrappers).includes("read:mac:/y"));
});

test("targets are deduplicated and capped", () => {
  const same = parse("cat /a /a /a; cat /a");
  assert.deepEqual(files(same), ["read:mac:/a"]);
  const many = parse(`cat ${Array.from({ length: 40 }, (_, i) => `/f/${i}`).join(" ")}`);
  assert.equal(many.targets.length, LIMITS.maxTargetsPerEvent);
  assert.equal(many.targets[0].path, "/f/0");
  // structural targets survive the cap
  const mixed = parse(`cat ${Array.from({ length: 40 }, (_, i) => `/f/${i}`).join(" ")}; kubectl --context chengdu logs pod-1`);
  assert.equal(mixed.targets.length, LIMITS.maxTargetsPerEvent);
  assert.ok(mixed.targets.some(t => t.type === "pod" && t.name === "pod-1"));
});

test("all emitted types and categories are protocol values", () => {
  const cmds = [`${WRAPPER} os -- get pods`, "ssh sg-compute 'cat /x'", "curl https://a.b", "omp -p x", "kubectl --context chengdu cp pod:/a ./b", "scp a h:/b"];
  for (const cmd of cmds) {
    const r = parse(cmd);
    assert.ok(TOOL_CATEGORIES.includes(r.category), cmd);
    for (const t of r.targets) assert.ok(TARGET_TYPES.includes(t.type), cmd);
  }
});

// ───────────────────────────────────────────── native tools ─────────────────────────────────────────────

const PATCH = [
  "*** Begin Patch",
  "*** Add File: docs/new.md",
  "+hello",
  "*** Update File: src/a.ts",
  "*** Move to: src/b.ts",
  "@@",
  "-old",
  "+new",
  "*** Delete File: /abs/old.txt",
  "*** End Patch",
].join("\n");

test("codex apply_patch: Add / Update / Move to / Delete", () => {
  const r = tool("apply_patch", PATCH, "codex", { cwd: "/Users/me/work" });
  assert.equal(r.category, "edit");
  assert.deepEqual(files(r), [
    "write:mac:/Users/me/work/docs/new.md", "edit:mac:/Users/me/work/src/a.ts", "write:mac:/Users/me/work/src/b.ts", "delete:mac:/abs/old.txt",
  ]);
  assert.equal(r.preview, "apply_patch: add docs/new.md, update src/a.ts → src/b.ts, delete /abs/old.txt");
});

test("codex apply_patch of only new files is a write", () => {
  const r = tool("apply_patch", "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch", "codex");
  assert.equal(r.category, "write");
  assert.deepEqual(files(r), ["write:mac:/Users/me/work/a.txt"]);
});

test("codex exec_command with apply_patch heredoc is classified as the patch", () => {
  const r = tool("exec_command", { cmd: `apply_patch <<'PATCH'\n${PATCH}\nPATCH`, workdir: "/Users/me/other" }, "codex");
  assert.equal(r.category, "edit");
  assert.deepEqual(files(r), [
    "write:mac:/Users/me/other/docs/new.md", "edit:mac:/Users/me/other/src/a.ts", "write:mac:/Users/me/other/src/b.ts", "delete:mac:/abs/old.txt",
  ]);
  assert.equal(r.preview, "apply_patch: add docs/new.md, update src/a.ts → src/b.ts, delete /abs/old.txt");
});

test("codex exec_command: cmd + workdir, preview is the command", () => {
  const r = tool("exec_command", { cmd: "sed -n '1,40p' lib/x.mjs", workdir: "/srv/repo", max_output_tokens: 1000 }, "codex");
  assert.deepEqual(files(r), ["read:mac:/srv/repo/lib/x.mjs"]);
  assert.equal(r.preview, "sed -n '1,40p' lib/x.mjs");
  assert.equal(r.category, "shell");
});

test("codex shell/local_shell with an argv array", () => {
  const r = tool("shell", { command: ["bash", "-lc", "cat notes.md"], workdir: "/srv/repo" }, "codex");
  assert.deepEqual(files(r), ["read:mac:/srv/repo/notes.md"]);
  assert.equal(r.preview, "cat notes.md");
});

test("codex code-mode exec: exec_command and apply_patch calls inside the JS are parsed", () => {
  const js = 'const r = await tools.exec_command({cmd:"cat src/a.ts && kubectl --context chengdu logs pod-1",workdir:"/srv/repo",max_output_tokens:1000}); text(JSON.stringify(r));';
  const r = tool("exec", js, "codex");
  assert.equal(r.category, "k8s");
  assert.deepEqual(r.targets.map(t => t.type === "file" ? t.path : `${t.type}:${t.name}`), ["/srv/repo/src/a.ts", "pod:pod-1"]);
  const p = tool("exec", 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /w/a.ts\\n@@\\n-x\\n+y\\n*** End Patch\\n"))', "codex");
  assert.deepEqual(files(p), ["edit:mac:/w/a.ts"]);
  const opaque = tool("exec", "const x = await tools.update_plan({plan: []}); text(x);", "codex");
  assert.deepEqual(opaque.targets, []);
});

test("codex write_stdin never echoes what was typed", () => {
  const r = tool("write_stdin", { session_id: 321, chars: "correct-horse-battery-staple\n" }, "codex");
  assert.ok(!r.preview.includes("correct-horse"));
  assert.match(r.preview, /write_stdin 321/);
  assert.equal(r.category, "shell");
});

test("claude Edit / Write / Read / Grep / Glob", () => {
  const edit = tool("Edit", { file_path: "/srv/a.ts", old_string: "x", new_string: "y" });
  assert.deepEqual([edit.category, edit.preview, files(edit)], ["edit", "/srv/a.ts", ["edit:mac:/srv/a.ts"]]);
  const multi = tool("MultiEdit", { file_path: "/srv/b.ts", edits: [] });
  assert.deepEqual(files(multi), ["edit:mac:/srv/b.ts"]);
  const write = tool("Write", { file_path: "/srv/c.ts", content: "x" });
  assert.deepEqual([write.category, files(write)], ["write", ["write:mac:/srv/c.ts"]]);
  const read = tool("Read", { file_path: "/srv/d.ts", offset: 10, limit: 20 });
  assert.deepEqual([read.category, read.preview, files(read)], ["read", "/srv/d.ts:10+20", ["read:mac:/srv/d.ts"]]);
  const grep = tool("Grep", { pattern: "TODO", path: "/srv/src", glob: "*.ts" });
  assert.deepEqual([grep.category, grep.preview, files(grep)], ["search", "TODO in /srv/src", ["search:mac:/srv/src"]]);
  const glob = tool("Glob", { pattern: "**/*.test.mjs", path: "/srv" });
  assert.deepEqual([glob.category, files(glob)], ["search", ["list:mac:/srv"]]);
  assert.deepEqual(files(tool("NotebookEdit", { notebook_path: "/srv/n.ipynb", new_source: "x" })), ["edit:mac:/srv/n.ipynb"]);
});

test("claude Bash, BashOutput, Agent, WebFetch, WebSearch, TodoWrite, AskUserQuestion", () => {
  const bash = tool("Bash", { command: "ls /srv && cat /srv/x.txt", description: "list" });
  assert.deepEqual([bash.category, files(bash)], ["shell", ["list:mac:/srv", "read:mac:/srv/x.txt"]]);
  assert.equal(tool("BashOutput", { bash_id: "bash_1" }).category, "shell");
  const agent = tool("Agent", { description: "Find callers", subagent_type: "Explore", prompt: "long prompt…" });
  assert.deepEqual([agent.category, agent.preview, agent.targets], ["spawn", "Explore: Find callers", []]);
  assert.equal(tool("Task", { description: "Plan it", prompt: "x" }).category, "spawn");
  const fetch = tool("WebFetch", { url: "https://example.com/a?b=1", prompt: "summarize" });
  assert.deepEqual([fetch.category, fetch.targets], ["web", [{ type: "url", url: "https://example.com/a?b=1" }]]);
  assert.deepEqual([tool("WebSearch", { query: "node zstd" }).category, tool("WebSearch", { query: "node zstd" }).preview], ["web", "node zstd"]);
  const todo = tool("TodoWrite", { todos: [{ content: "a", status: "completed", activeForm: "Doing a" }, { content: "b", status: "in_progress", activeForm: "Doing b" }] });
  assert.deepEqual([todo.category, todo.preview], ["coordination", "2 items: Doing b"]);
  assert.equal(tool("AskUserQuestion", { questions: [{ question: "Which color?", header: "c", options: [] }] }).preview, "Which color?");
});

test("claude MCP tools are 'other'; DSH-hosted MCP tools classify as the underlying tool", () => {
  const mcp = tool("mcp__github__create_issue", { title: "Bug" });
  assert.deepEqual([mcp.category, mcp.preview], ["other", "mcp github.create_issue: Bug"]);
  const bash = tool("mcp__dshteam_6193fc1d695190b5__bash", { command: "cat /etc/hosts" });
  assert.deepEqual([bash.category, files(bash)], ["shell", ["read:mac:/etc/hosts"]]);
  const unknown = tool("mcp__dsh_unknown", { x: 1 });
  assert.deepEqual([unknown.category, unknown.preview], ["other", "mcp dsh_unknown: x=1"]); // not the catch-all fallback: no runaway recursion
});

test("omp read: line ranges and selectors are stripped from the path", () => {
  for (const [path, expect] of [
    ["src/a.ts:50-80", "/Users/me/work/src/a.ts"], ["src/a.ts:raw", "/Users/me/work/src/a.ts"], ["src/a.ts:raw:296-328", "/Users/me/work/src/a.ts"],
    ["/abs/b.md:-60", "/abs/b.md"], ["/abs/c.py:5-16,960-973", "/abs/c.py"], ["src/a.ts:50+30", "/Users/me/work/src/a.ts"],
  ]) {
    const r = tool("read", { path }, "omp");
    assert.deepEqual([r.category, r.targets], ["read", [{ type: "file", op: "read", host: "mac", path: expect }]], path);
    assert.equal(r.preview, path);
  }
  assert.deepEqual(files(tool("read", { path: "docs/" }, "omp")), ["list:mac:/Users/me/work/docs"]);
});

test("omp read ssh://host/path becomes a host target plus a file on that host", () => {
  const r = tool("read", { path: "ssh://sg-compute/etc/x:1-20" }, "omp");
  assert.deepEqual(r.targets, [
    { type: "host", op: "ssh", host: "sg-compute", site: "sg-compute" },
    { type: "file", op: "read", host: "sg-compute", path: "/etc/x" },
  ]);
  const other = tool("read", { path: "ssh://bochao_li@10.0.60.98/data/y.log" }, "omp");
  assert.deepEqual(other.targets[1], { type: "file", op: "read", host: "server-bochao-01", path: "/data/y.log" });
  assert.deepEqual(tool("read", { path: "ssh://" }, "omp").targets, []);
  assert.deepEqual(tool("grep", { pattern: "x", path: "ssh://box7/srv/app" }, "omp").targets.map(t => t.type === "file" ? `${t.op}:${t.host}:${t.path}` : t.type),
    ["host", "search:box7:/srv/app"]);
});

test("omp pseudo URLs are not files: agent://, local://, artifact://, skill://, history://, xd://, proc://, mcp://", () => {
  for (const path of ["agent://Readers", "local://plan.md", "artifact://12:70-140", "skill://cluster-task-monitor", "history://Panel:-60", "xd://eval/browser", "proc://bg_1", "mcp://x/y", "conflict://1"]) {
    assert.deepEqual(tool("read", { path }, "omp").targets, [], path);
  }
  assert.deepEqual(tool("read", { path: "https://example.com/doc" }, "omp").targets, [{ type: "url", url: "https://example.com/doc" }]);
  assert.deepEqual(files(tool("read", { path: "file:///etc/hosts" }, "omp")), ["read:mac:/etc/hosts"]);
  assert.deepEqual(tool("write", { path: "local://notes.md", content: "x" }, "omp").targets, []);
});

test("omp write to agent:// is coordination, to proc:// is shell, to xd:// calls that tool", () => {
  const msg = tool("write", { path: "agent://Readers", content: "please rebase\nthanks" }, "omp");
  assert.deepEqual([msg.category, msg.preview, msg.targets], ["coordination", "→ Readers: please rebase", []]);
  assert.equal(tool("write", { path: "proc://bg_3/kill" }, "omp").category, "shell");
  const ast = tool("write", { path: "xd://ast_edit", content: JSON.stringify({ ops: [{ pat: "a", out: "b" }], paths: ["src/a.ts", "src/b.ts"] }) }, "omp");
  assert.deepEqual([ast.category, files(ast)], ["edit", ["edit:mac:/Users/me/work/src/a.ts", "edit:mac:/Users/me/work/src/b.ts"]]);
  assert.equal(tool("write", { path: "xd://report_issue", content: "plain text" }, "omp").category, "other");
});

test("omp edit: hashline blocks give edit / delete / rename targets", () => {
  const input = "[src/a.ts#AB12]\nPUT 1.=1:\n+x\n[old.txt#CD34]\nREM\n[m.txt#EF56]\nMV n.txt\n";
  const r = tool("edit", { input }, "omp");
  assert.equal(r.category, "edit");
  assert.deepEqual(files(r), [
    "edit:mac:/Users/me/work/src/a.ts", "delete:mac:/Users/me/work/old.txt", "delete:mac:/Users/me/work/m.txt", "write:mac:/Users/me/work/n.txt",
  ]);
  assert.equal(r.preview, "src/a.ts, old.txt, m.txt");
  const withPath = tool("edit", { path: "lib/x.mjs", input: "PUT 1.=1:\n+y" }, "omp");
  assert.deepEqual(files(withPath), ["edit:mac:/Users/me/work/lib/x.mjs"]);
});

test("omp bash / grep / glob / write / task / todo / eval / wait", () => {
  const bash = tool("bash", { command: "cd sub && cat a.txt", cwd: "/Users/me/other", i: "show" }, "omp");
  assert.deepEqual(files(bash), ["read:mac:/Users/me/other/sub/a.txt"]);
  const grep = tool("grep", { pattern: "foo|bar", path: "src;docs" }, "omp");
  assert.deepEqual([grep.category, grep.preview, files(grep)], ["search", "foo|bar in src;docs", ["search:mac:/Users/me/work/src", "search:mac:/Users/me/work/docs"]]);
  assert.deepEqual(files(tool("glob", { path: "src/**/*.ts" }, "omp")), ["list:mac:/Users/me/work/src/**/*.ts"]);
  assert.deepEqual(files(tool("write", { path: "out/r.md", content: "x" }, "omp")), ["write:mac:/Users/me/work/out/r.md"]);
  const task = tool("task", { context: "ctx", tasks: [{ name: "Readers", agent: "task", task: "do it" }, { name: "Panel", task: "do that" }] }, "omp");
  assert.deepEqual([task.category, task.preview, task.targets], ["spawn", "Readers, Panel", []]);
  assert.deepEqual(tool("todo", { op: "done", task: "Wire hub" }, "omp").preview, "done: Wire hub");
  const ev = tool("eval", { language: "py", code: "import os\nos.remove('/x')", title: "Cleanup" }, "omp");
  assert.deepEqual([ev.category, ev.preview, ev.targets], ["shell", "eval py: Cleanup", []]);
  assert.equal(tool("wait", { i: "Waiting for builders" }, "omp").category, "coordination");
  assert.equal(tool("web_search", { query: "zstd frames" }, "omp").category, "web");
  assert.equal(tool("lsp", { action: "rename", file: "a.ts", symbol: "x", new_name: "y", apply: true }, "omp").category, "edit");
  assert.equal(tool("ask", { questions: [{ id: "a", question: "Which?" }] }, "omp").preview, "Which?");
});

test("omp hub start parses the launched application", () => {
  const r = tool("hub", { op: "start", name: "web", application: "python3", args: ["serve.py", "8001"], cwd: "/srv/site" }, "omp");
  assert.deepEqual(files(r), ["exec:mac:/srv/site/serve.py"]);
  assert.equal(tool("hub", { op: "stop", name: "web" }, "omp").category, "shell");
});

test("dsh tools: bash / read / write / edit / grep / glob / subagent / peer_send_message / web / run_code", () => {
  const bash = tool("bash", { command: "kubectl --context weihai -n mc-bochao-li logs pod-2", cwd: "/srv", description: "logs" }, "dsh");
  assert.deepEqual([bash.category, bash.targets.map(t => t.name)], ["k8s", ["pod-2"]]);
  assert.deepEqual(files(tool("read", { file_path: "/srv/a.txt", offset: 5, limit: 10 }, "dsh")), ["read:mac:/srv/a.txt"]);
  assert.deepEqual(files(tool("write", { path: "/srv/b.txt", content: "x" }, "dsh")), ["write:mac:/srv/b.txt"]);
  assert.deepEqual(files(tool("edit", { file_path: "/srv/c.txt", old_string: "a", new_string: "b" }, "dsh")), ["edit:mac:/srv/c.txt"]);
  assert.deepEqual(files(tool("str_replace_editor", { command: "view", path: "/srv/d.txt" }, "dsh")), ["read:mac:/srv/d.txt"]);
  assert.equal(tool("grep", { pattern: "x", path: "/srv" }, "dsh").category, "search");
  assert.equal(tool("glob", { pattern: "**/*.js" }, "dsh").category, "search");
  const sub = tool("subagent", { description: "Echo test", prompt: "Reply with TEL-1" }, "dsh");
  assert.deepEqual([sub.category, sub.preview], ["spawn", "Echo test"]);
  assert.equal(tool("subagent_fork", { description: "Fork it", prompt: "x" }, "dsh").category, "spawn");
  const msg = tool("peer_send_message", { agent_id: "session-abc", message: "TEL-DSH-FORK" }, "dsh");
  assert.deepEqual([msg.category, msg.preview], ["coordination", "→ session-abc: TEL-DSH-FORK"]);
  const fetch = tool("web_fetch", { url: "https://example.com/x" }, "dsh");
  assert.deepEqual([fetch.category, fetch.targets], ["web", [{ type: "url", url: "https://example.com/x" }]]);
  assert.equal(tool("web_search", { queries: ["a b", "c d"] }, "dsh").preview, "a b | c d");
  assert.equal(tool("run_code", { code: "print(1)", language: "py" }, "dsh").category, "shell");
  assert.equal(tool("todo_write", { todos: [{ content: "x", status: "pending" }] }, "dsh").category, "coordination");
});

test("dsh calls named by their title are classified from the arguments", () => {
  const w = tool("Creating game favicon", { path: "public/favicon.svg", content: "<svg/>" }, "dsh");
  assert.deepEqual([w.category, files(w)], ["write", ["write:mac:/Users/me/work/public/favicon.svg"]]);
  const e = tool("Removing unused imports", { path: "src/main.ts", old_string: "a", new_string: "b" }, "dsh");
  assert.deepEqual([e.category, files(e)], ["edit", ["edit:mac:/Users/me/work/src/main.ts"]]);
  const r = tool("Reviewing route module", { path: "src/route.ts:240-520" }, "dsh");
  assert.deepEqual([r.category, files(r)], ["read", ["read:mac:/Users/me/work/src/route.ts"]]);
  const s = tool("Locating callers", { path: "src", pattern: "finishNode" }, "dsh");
  assert.equal(s.category, "search");
  assert.equal(tool("Creating game favicon", { path: "x.svg", content: "" }, "codex").category, "other"); // only DSH names tools by title
  assert.equal(tool("Waiting for tokens", {}, "dsh").category, "other");
});

test("unknown tools are 'other' with a readable preview; garbage input never throws", () => {
  const r = tool("fancy_plugin_tool", { query: "find things", limit: 5 });
  assert.deepEqual([r.category, r.targets], ["other", []]);
  assert.match(r.preview, /fancy_plugin_tool/);
  for (const input of [undefined, null, 5, "str", [], [1, 2], { path: 5 }, { command: 7 }, { command: [1, 2] }, { tasks: "x" }, { input: {} }]) {
    for (const name of ["Bash", "bash", "Read", "read", "Edit", "edit", "write", "apply_patch", "exec", "Agent", "task", "WebFetch", "grep", "todo", "wait", "hub", "lsp", "ast_edit", "nope"]) {
      const out = classifyTool({ kind: "omp", name, input, ...MAC });
      assert.ok(TOOL_CATEGORIES.includes(out.category), `${name} ${JSON.stringify(input)}`);
      assert.equal(typeof out.preview, "string");
      assert.ok(Array.isArray(out.targets));
    }
  }
  assert.deepEqual(classifyTool(undefined).targets, []);
  assert.deepEqual(classifyTool({}).category, "other");
});

test("tool names are matched case-insensitively and ignoring separators", () => {
  for (const name of ["Bash", "BASH", "bash"]) assert.equal(tool(name, { command: "cat /a" }).category, "shell");
  for (const name of ["web_fetch", "WebFetch", "webfetch"]) assert.equal(tool(name, { url: "https://a.b/" }).category, "web");
  for (const name of ["exec_command", "execCommand"]) assert.deepEqual(files(tool(name, { cmd: "cat /a" })), ["read:mac:/a"]);
  assert.equal(tool("functions.exec_command", { cmd: "cat /a" }, "codex").category, "shell");
});

// ───────────────────────────────────────────── previews ─────────────────────────────────────────────

test("preview of shell tools is the unwrapped command on one line", () => {
  assert.equal(tool("Bash", { command: "bash -lc 'cd /work && sed -n 1,20p src/a.ts > /tmp/out.txt'" }).preview, "cd /work && sed -n 1,20p src/a.ts > /tmp/out.txt");
  assert.equal(tool("Bash", { command: "bash -c \"sh -c 'echo hi'\"" }).preview, "echo hi");
  assert.equal(tool("Bash", { command: "eval 'cat /a'" }).preview, "cat /a");
  assert.equal(tool("Bash", { command: "set -e\ncat /a\n  cat /b\n" }).preview, "set -e; cat /a; cat /b");
  assert.equal(tool("Bash", { command: "kubectl get pods \\\n  -n mc-bochao-li" }).preview, "kubectl get pods -n mc-bochao-li");
  assert.equal(tool("Bash", { command: "if [ -f x ]; then\n  cat x\nfi" }).preview, "if [ -f x ]; then cat x; fi");
});

test("preview shows the user's cluster wrapper as plain kubectl with its context", () => {
  const r = tool("Bash", { command: `env PYTHONDONTWRITEBYTECODE=1 ${WRAPPER} ulanqab-osmium -- -n mc-bochao-li get pods` });
  assert.equal(r.preview, "kubectl --context ulanqab-osmium -n mc-bochao-li get pods");
});

test("preview cuts heredoc bodies but keeps what follows", () => {
  const r = tool("Bash", { command: "python3 - <<'PY'\nprint('lots of code')\nPY\nls -la" });
  assert.equal(r.preview, "python3 - <<'PY' … PY; ls -la");
  assert.ok(!r.preview.includes("lots of code"));
});

test("previews are redacted before they are cut, and never exceed the limit", () => {
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const cmd = `curl -H 'Authorization: Bearer abcdefghijklmnop1234' --token ${secret} -d 'password=hunter2hunter2' https://x.io && export OPENAI_API_KEY=${secret}`;
  const r = tool("Bash", { command: cmd });
  assert.ok(!r.preview.includes("abcdefghijklmnop1234"));
  assert.ok(!r.preview.includes(secret));
  assert.ok(!r.preview.includes("hunter2"));
  assert.match(r.preview, /‹redacted›/);
  // a secret that straddles the cut is masked, not half shown
  const straddle = "x".repeat(LIMITS.previewChars - 12) + " --token " + secret;
  const cut = tool("Bash", { command: `echo ${straddle}` });
  assert.ok(cut.preview.length <= LIMITS.previewChars);
  assert.ok(!cut.preview.includes("sk-ant"));
  const long = tool("Bash", { command: "echo " + "y".repeat(5000) });
  assert.equal(long.preview.length, LIMITS.previewChars);
  assert.ok(long.preview.endsWith("…"));
  assert.equal(tool("Bash", { command: "echo ok" }).preview, "echo ok");
});

test("secrets in a command never reach targets", () => {
  const r = parse("curl https://user:hunter2hunter2@host.example/x?api_key=abcdefghij123456 -H 'Authorization: Bearer abcdefghijklmnop1234'");
  const text = JSON.stringify(r.targets);
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes("abcdefghij123456"));
  assert.ok(!text.includes("abcdefghijklmnop1234"));
});

test("previews of non-shell tools: path + range, pattern + path, child description", () => {
  assert.equal(tool("Read", { file_path: "/a.ts" }).preview, "/a.ts");
  assert.equal(tool("Read", { file_path: "/a.ts", offset: 5 }).preview, "/a.ts:5-");
  assert.equal(tool("Grep", { pattern: "x" }).preview, "x");
  assert.equal(tool("Glob", { pattern: "*.md", path: "/docs" }).preview, "*.md in /docs");
  assert.equal(tool("Agent", { description: "Check logs", prompt: "…" }).preview, "Check logs");
  assert.equal(tool("spawn_agent", { task_name: "h100_retest", message: "gAAAAABq5BpGutk9oplgVymYequvbOC1EmmSYeBNWS" }, "codex").preview, "h100_retest");
  assert.equal(tool("send_message", { target: "baseline_fresh", message: "gAAAAABq5ByP8ZEM-LbuzbfJEhceww7mIOz5bUSRtAMvlPnyIMEYLyb7t9" }, "codex").preview, "→ baseline_fresh");
});

test("every classifyTool result has protocol-valid category and target types", () => {
  const calls = [
    ["Bash", { command: "ssh sg-compute 'omp -p x'" }], ["Read", { file_path: "/a" }], ["Agent", { description: "d" }], ["WebFetch", { url: "https://a.b/" }],
    ["mcp__x__y", {}], ["TodoWrite", { todos: [] }], ["apply_patch", PATCH], ["Glob", { pattern: "*" }],
  ];
  for (const [name, input] of calls) {
    const r = tool(name, input);
    assert.ok(TOOL_CATEGORIES.includes(r.category), name);
    assert.ok(r.targets.length <= LIMITS.maxTargetsPerEvent);
    assert.ok(r.preview.length <= LIMITS.previewChars);
    for (const t of r.targets) assert.ok(TARGET_TYPES.includes(t.type), name);
  }
});
