// Agent Fleet wire contract, shared by collectors, the hub, the panel and the DSH plugin.
// Every record crossing a process boundary is plain JSON described by the typedefs below.
// Times are epoch milliseconds. Collectors report their own clock; the hub normalizes by skew.

export const PROTOCOL_VERSION = 1;

/** Agent kinds the fleet understands. */
export const AGENT_KINDS = Object.freeze(["dsh", "claude", "codex", "omp"]);
export const KIND_LABELS = Object.freeze({ dsh: "DeepSeek Harness", claude: "Claude Code", codex: "Codex", omp: "Oh My Pi" });

/** Sites: the places the user groups machines by. Pods belong to the site of their cluster. */
export const SITES = Object.freeze(["mac", "server-bochao-01", "sg-compute", "chengdu", "weihai", "iron", "os"]);
export const SITE_LABELS = Object.freeze({
  mac: "本机 Mac",
  "server-bochao-01": "server-bochao-01",
  "sg-compute": "sg-compute",
  chengdu: "成都 chengdu",
  weihai: "威海 weihai",
  iron: "乌兰察布 iron",
  os: "乌兰察布 osmium",
});

/** Kubernetes sites and their kubeconfig context in ~/Documents/dsh-credentials/kubeconfig.yaml. */
export const KUBE_CONTEXTS = Object.freeze({ chengdu: "chengdu", weihai: "weihai", iron: "ulanqab-iron", os: "ulanqab-osmium" });
export const NAMESPACE = "mc-bochao-li";
/** Pods carrying this label (value "true") get a collector attached by the hub. */
export const COLLECT_LABEL = "agent-fleet.omgwow.ai/collect";

/** Context names, cluster aliases and wrapper arguments seen in commands, mapped to sites. */
const CLUSTER_ALIASES = {
  chengdu: "chengdu", "chengdu-h100": "chengdu", cd: "chengdu",
  weihai: "weihai", "weihai-h100": "weihai", wh: "weihai",
  "ulanqab-iron": "iron", iron: "iron", "jiaqi-b300": "iron", "jq-b300": "iron", ulanqab: "iron", b300: "iron",
  "ulanqab-osmium": "os", osmium: "os", os: "os",
};
/** Returns the site of a kube context / cluster alias, or null when it is not one of the fleet clusters. */
export function siteOfCluster(name) {
  if (typeof name !== "string") return null;
  const bare = name.trim().toLowerCase().replace(/^mixed-cloud-bochao-li-/, "").replace(/-mc-bochao-li$/, "");
  return CLUSTER_ALIASES[bare] ?? null;
}

/** SSH aliases / addresses of fleet hosts, mapped to sites. Anything else is reported verbatim. */
const SSH_ALIASES = {
  "sg-compute": "sg-compute", "10.0.1.138": "sg-compute", "oracle-sg-cpu-compute00001": "sg-compute",
  "server-bochao-01": "server-bochao-01", "10.0.60.98": "server-bochao-01",
};
export function siteOfSshTarget(target) {
  if (typeof target !== "string") return null;
  const host = target.replace(/^[^@]*@/, "").replace(/:.*$/, "").trim().toLowerCase();
  return SSH_ALIASES[host] ?? null;
}

/** Host ids: "mac", "server-bochao-01", "sg-compute", and "k8s/<site>/<pod>" for pods. */
export function podHostId(site, pod) { return `k8s/${site}/${pod}`; }
export function parsePodHostId(hostId) {
  const match = /^k8s\/([^/]+)\/(.+)$/.exec(hostId ?? "");
  return match ? { site: match[1], pod: match[2] } : null;
}

/** Agent keys: `<hostId>#<kind>:<nativeId>`. Global keys drop the host: `<kind>:<nativeId>`. */
export function agentKey(hostId, kind, id) { return `${hostId}#${kind}:${id}`; }
export function globalKey(kind, id) { return `${kind}:${id}`; }
export function parseAgentKey(key) {
  const hash = typeof key === "string" ? key.indexOf("#") : -1;
  if (hash <= 0) return null;
  const rest = key.slice(hash + 1), colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const kind = rest.slice(0, colon), id = rest.slice(colon + 1);
  if (!AGENT_KINDS.includes(kind) || id === "") return null;
  return { hostId: key.slice(0, hash), kind, id, global: rest };
}
export function podKey(site, namespace, name) { return `${site}/${namespace}/${name}`; }

export const ROLES = Object.freeze(["main", "subagent", "fork", "side", "projection"]);
/** running: a turn is open and the agent is working; idle: process alive, no open turn; waiting: blocked on the user. */
export const STATUSES = Object.freeze(["running", "waiting", "idle", "done", "error", "interrupted", "stale", "unknown"]);
export const LIVE_STATES = Object.freeze(["model", "tool", "waiting", "idle", "ended"]);
export const EVENT_TYPES = Object.freeze(["user", "model", "tool", "spawn", "message", "compaction", "error", "turn"]);
export const TOOL_CATEGORIES = Object.freeze(["read", "write", "edit", "search", "shell", "remote", "k8s", "spawn", "web", "coordination", "other"]);
export const TARGET_TYPES = Object.freeze(["file", "pod", "k8s", "host", "url", "agent"]);
export const LINK_VIA = Object.freeze(["file", "acp", "env", "command", "process"]);

/** Process env names collectors read from agent processes. AGENT_FLEET_PARENT holds a global or full agent key. */
export const ENV_PARENT = "AGENT_FLEET_PARENT";
export const ENV_PARENT_CALL = "AGENT_FLEET_PARENT_CALL";

/** Collector → hub message types. */
export const C2H = Object.freeze(["hello", "agent", "events", "gone", "procs", "heartbeat", "reply"]);
/** Hub → collector message types. */
export const H2C = Object.freeze(["request", "reply"]);
/** Requests a hub may send to a collector. */
export const COLLECTOR_METHODS = Object.freeze(["file.read", "agent.events", "ping"]);
/** Requests the hub API answers (HTTP GET api/<method>, or hub.api.request in-process). */
export const HUB_METHODS = Object.freeze(["snapshot", "changes", "family", "agent", "pods", "pod", "file", "query", "hosts", "health"]);

export const LIMITS = Object.freeze({
  previewChars: 200,
  textChars: 240,
  cmdChars: 300,
  pathChars: 1024,
  maxTargetsPerEvent: 16,
  fileReadBytes: 256 * 1024,
  initialEventsPerAgent: 400,
  hubEventsPerAgent: 3000,
  feedItems: 300,
  lineBytes: 16 * 1024 * 1024,
});

/**
 * @typedef {"dsh"|"claude"|"codex"|"omp"} AgentKind
 *
 * @typedef {object} HostInfo   Sent by a collector in `hello`.
 * @property {string} id         "mac" | "server-bochao-01" | "sg-compute" | "k8s/<site>/<pod>"
 * @property {string} site       one of SITES (or another string for hosts outside the fleet)
 * @property {"workstation"|"server"|"pod"} kind
 * @property {string} label      human label
 * @property {string} hostname
 * @property {string} platform   process.platform
 * @property {string} [cluster]  kube context (pods only)
 * @property {string} [namespace]
 * @property {string} [pod]
 * @property {string} [node]     kube node name (pods only)
 * @property {{dsh:string[],claude:string[],codex:string[],omp:string[]}} roots  session roots watched
 *
 * @typedef {object} ParentHint  How a session names its parent; the collector fills `key` when it resolved it locally.
 * @property {string} [key]      full agent key (same host)
 * @property {AgentKind} [kind]  with `id`: global lookup on any host
 * @property {string} [id]
 * @property {string} [file]     parent transcript path on the same host (collector resolves it)
 * @property {"file"|"acp"|"env"|"command"|"process"} via
 * @property {boolean} exact
 * @property {string} [toolCallId] the parent's tool call that spawned this child
 *
 * @typedef {object} AgentLive
 * @property {boolean|null} alive   a live process is matched (null: unknown on this platform)
 * @property {number} [pid]
 * @property {"model"|"tool"|"waiting"|"idle"|"ended"} state
 * @property {number} since         ms when `state` began
 * @property {string} doing         one line: open tool preview, "thinking", "waiting for user", ""
 * @property {boolean} turnOpen
 *
 * @typedef {object} AgentRecord  One session (main agent, subagent, fork, side chat). Full record on every upsert.
 * @property {string} key        agentKey(host, kind, id)
 * @property {string} host
 * @property {string} site
 * @property {AgentKind} kind
 * @property {string} id         native session id (claude subagents: "<sessionId>/<agentId>")
 * @property {string} file       transcript path on `host`
 * @property {string} cwd
 * @property {string} title
 * @property {string} model
 * @property {string} [provider]
 * @property {string} [effort]
 * @property {"main"|"subagent"|"fork"|"side"|"projection"|"probe"} role   projection: DSH's mirror of an ACP agent's subagent; probe: ACP model-catalog handshake (never a link target)
 * @property {string} [name]     subagent label / task id
 * @property {string} [description]
 * @property {ParentHint|null} parent
 * @property {number} startedAt
 * @property {number} updatedAt  time of the last transcript event
 * @property {number|null} endedAt
 * @property {"running"|"waiting"|"idle"|"done"|"error"|"interrupted"|"stale"|"unknown"} status
 * @property {AgentLive} live
 * @property {{input:number,output:number,cacheRead:number,cacheWrite:number,reasoning:number,cost?:number,contextTokens?:number,contextWindow?:number}} usage
 * @property {{turns:number,tools:number,errors:number,subagents:number,events:number}} counts
 * @property {{provider:string,kind:AgentKind,id:string}} [acp]  DSH session bound to a native agent session over ACP
 * @property {string} [version]  agent CLI version
 * @property {string} [container] container / run label when the session lives inside one (e.g. podman run)
 *
 * @typedef {object} Target  What a tool call touched.
 * @property {"file"|"pod"|"k8s"|"host"|"url"|"agent"} type
 * @property {string} [op]        file: read|write|edit|list|search|delete|exec; pod: exec|logs|get|describe|delete|apply|cp|port-forward|other; host: ssh|scp|rsync; agent: launch
 * @property {string} [host]      file: host id holding the file; host: raw ssh target
 * @property {string} [path]      file: absolute path
 * @property {string} [site]      pod/k8s/agent: site; host: resolved site or null
 * @property {string} [cluster]   pod/k8s: kube context as written
 * @property {string} [namespace]
 * @property {string} [name]      pod name (pod), resource name (k8s)
 * @property {string} [container]
 * @property {string} [resource]  k8s: resource kind (deployment, job, ...)
 * @property {string} [url]
 * @property {AgentKind} [kind]   agent: launched agent kind
 * @property {string} [pod]       agent: pod name when launched inside a pod
 * @property {"acp"|"cli"} [transport]
 *
 * @typedef {object} AgentEvent  One timeline item. Upserted by `id` within its agent.
 * @property {string} id          tool call id for tools; otherwise "<type>:<n>" stable for the transcript position
 * @property {"user"|"model"|"tool"|"spawn"|"message"|"compaction"|"error"|"turn"} type
 * @property {number} t           start time
 * @property {number} [duration]  ms; absent while still open
 * @property {"pending"|"ok"|"error"|"unknown"} [status]
 * @property {string} [name]      tool name
 * @property {string} [category]  one of TOOL_CATEGORIES
 * @property {string} [preview]   ≤ LIMITS.previewChars, redacted
 * @property {Target[]} [targets]
 * @property {number} [exitCode]
 * @property {string} [model]
 * @property {{input?:number,output?:number,cacheRead?:number,cacheWrite?:number,reasoning?:number}} [usage]
 * @property {number} [ttft]
 * @property {{kind?:AgentKind,id?:string,name?:string,key?:string}} [child]  spawn: the child named by the call
 * @property {string} [peer]      message: the other agent (name, id or key)
 * @property {string} [text]      ≤ LIMITS.textChars, redacted (user prompt head, model text head, error text)
 *
 * @typedef {object} Proc  An agent process seen by a collector.
 * @property {number} pid
 * @property {number} ppid
 * @property {AgentKind|"acp-bridge"|"kubectl"|"ssh"} kind
 * @property {number} startedAt
 * @property {string} [cwd]
 * @property {string} cmd          redacted, ≤ LIMITS.cmdChars
 * @property {string} [agent]      matched agent key
 * @property {string} [parent]     AGENT_FLEET_PARENT (or LC_AGENT_FLEET_PARENT) from the process env
 * @property {{kind:AgentKind,id:string,via:"env",exact:true}} [parentSession]  session of the nearest ancestor agent, read from the
 *           native id var it exports to shell children (PI_SESSION_ID, CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, DSH_SESSION_ID)
 * @property {string} [parentCall]  CODEX_TOOL_CALL_ID / AGENT_FLEET_PARENT_CALL when present
 * @property {{kind:"dsh",id:string}} [via]  AGENT_FLEET_VIA=dsh:<id>: launched by that DSH session's ACP adapter
 * @property {{site?:string,pod?:string,host?:string}} [remote]  kubectl exec / ssh destination when the process runs an agent remotely
 *
 * @typedef {object} FilePreview  Reply to file.read and body of hub api/file.
 * @property {string} host
 * @property {string} path
 * @property {boolean} exists
 * @property {number} [size]
 * @property {number} [mtime]
 * @property {boolean} [truncated]
 * @property {boolean} [binary]
 * @property {string} [content]   utf8, redacted; absent for binary
 * @property {number} [redactions]
 * @property {string} [denied]    reason when the read was refused
 *
 * @typedef {object} Host  Hub view of a host: HostInfo plus connection state.
 * @property {"online"|"offline"|"error"|"connecting"} status
 * @property {"local"|"socket"|"ssh-relay"|"pod-exec"} via
 * @property {number} [connectedAt]
 * @property {number} [lastSeen]
 * @property {number} [lagMs]     hub receive time − collector send time of the last heartbeat (after skew)
 * @property {number} [skewMs]    hub clock − collector clock
 * @property {string} [error]
 * @property {{agents:number,running:number}} counts
 *
 * @typedef {object} Link  Effective parent → child edge computed by the hub.
 * @property {string} from
 * @property {string} to
 * @property {"file"|"acp"|"env"|"command"|"process"} via
 * @property {boolean} exact
 * @property {string} [toolCallId]
 * @property {boolean} crossHost
 * @property {boolean} crossSite
 *
 * @typedef {object} Pod  Compact pod state from the kube watch.
 * @property {string} key        podKey(site, namespace, name)
 * @property {string} site
 * @property {string} cluster    kube context
 * @property {string} namespace
 * @property {string} name
 * @property {string} phase
 * @property {string} ready      "1/1"
 * @property {number} restarts
 * @property {string} [node]
 * @property {string} [podIP]
 * @property {number} [createdAt]
 * @property {number} [startedAt]
 * @property {number} [deletedAt]
 * @property {{name:string,image:string,ready:boolean,state:string,restarts:number}[]} containers
 * @property {{cpu?:string,memory?:string,gpu?:number}} requests
 * @property {{kind:string,name:string}} [owner]
 * @property {Record<string,string>} labels
 * @property {boolean} collect   carries COLLECT_LABEL=true
 * @property {string} [hostId]   podHostId when a collector is attached
 *
 * @typedef {object} Touch  One agent event that targeted a pod or file.
 * @property {string} agent
 * @property {string} event
 * @property {number} t
 * @property {string} [op]
 * @property {string} [category]
 *
 * @typedef {object} Snapshot
 * @property {number} cursor
 * @property {number} now
 * @property {{version:string,startedAt:number,hostId:string}} hub
 * @property {Host[]} hosts
 * @property {AgentRecord[]} agents
 * @property {Link[]} links
 * @property {Pod[]} pods       pods touched by agents or hosting a collector
 * @property {{agent:string,event:AgentEvent}[]} feed  latest events across the fleet, newest last
 *
 * @typedef {object} Delta
 * @property {number} cursor
 * @property {number} now
 * @property {boolean} [reset]   cursor unknown/too old: the client must reload the snapshot
 * @property {Host[]} [hosts]
 * @property {AgentRecord[]} [agents]
 * @property {string[]} [removed]
 * @property {Link[]} [links]    full replacement of the link set when present
 * @property {Pod[]} [pods]
 * @property {string[]} [podsRemoved]
 * @property {{agent:string,event:AgentEvent}[]} [feed]
 */

/** Cheap structural check for incoming channel messages; returns an error string or null. */
export function checkMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return "message is not an object";
  if (typeof message.t !== "string") return "message has no type";
  if (message.t === "hello" && (typeof message.host?.id !== "string" || message.proto !== PROTOCOL_VERSION)) return "bad hello";
  if (message.t === "agent" && typeof message.agent?.key !== "string") return "agent without key";
  if (message.t === "events" && (typeof message.agent !== "string" || !Array.isArray(message.events))) return "bad events";
  if ((message.t === "request" || message.t === "reply") && typeof message.id !== "string") return "request/reply without id";
  return null;
}
