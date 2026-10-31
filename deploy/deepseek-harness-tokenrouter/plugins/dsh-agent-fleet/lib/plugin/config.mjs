// Validated settings of the DSH plugin row `dsh-agent-fleet` (see cordis.patch.yml / configure.mjs).
//   mode        "remote" (default): HTTP client of the hub on this machine · "embedded": hub inside the DSH process (Mac desktop)
//   hubUrl      remote: the hub's HTTP root (default http://127.0.0.1:7840) · embedded: the server hub to follow, unless upstream.url
//   tokenFile   remote: the hub's token · embedded: the local hub's own token file (created by the hub when missing)
//   panelUrl    URL (or root-relative path) the browser iframes instead of the default; no ? or #
//   upstream    embedded only, the server hub this desktop follows and pushes to:
//                 sshTarget  login of the machine that runs it (user@host): carries the follow relay and the collector push
//                 url        its HTTP root as seen from that machine (default hubUrl / http://127.0.0.1:7840)
//                 tokenFile  its token (default ~/.config/agent-fleet/upstream-token; copy the server's token file there)
//                 ingestTokenFile  its ingest credential (default ~/.config/agent-fleet/upstream-ingest-token; copy the
//                            server's ~/.config/agent-fleet/ingest-token there) — read by embedded.mjs, never here
//   collector   embedded: {roots?: {dsh|claude|codex|omp: [dir]}, since?: "6h" | ms}; roots are extra session directories next to the defaults
//   hostId/site/httpPort   embedded: identity of this machine ("mac") and the port of the local hub (7846)
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const HUB_URL = "http://127.0.0.1:7840";
export const TOKEN_FILE = "~/.config/agent-fleet/token";
export const UPSTREAM_TOKEN_FILE = "~/.config/agent-fleet/upstream-token";
export const UPSTREAM_INGEST_TOKEN_FILE = "~/.config/agent-fleet/upstream-ingest-token";
export const EMBEDDED_PORT = 7846;
export const INGEST_PORT = 7841;

const KINDS = ["dsh", "claude", "codex", "omp"];
const KEYS = ["mode", "hubUrl", "tokenFile", "panelUrl", "upstream", "collector", "hostId", "site", "httpPort"];
const UPSTREAM_KEYS = ["sshTarget", "url", "tokenFile", "ingestTokenFile"];

function fail(message) { throw new Error(`dsh-agent-fleet config: ${message}`); }
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function onlyKeys(object, allowed, where) {
  const unknown = Object.keys(object).filter(key => !allowed.includes(key));
  if (unknown.length > 0) fail(`unknown key ${unknown.map(key => JSON.stringify(key)).join(", ")} in ${where} (valid: ${allowed.join(", ")})`);
}

/** `~` and `~/x` against the user's home; other paths unchanged. */
export function expandHome(path, home = homedir()) {
  if (path === "~") return home;
  return path.startsWith("~/") ? resolve(home, path.slice(2)) : path;
}

function text(value, name) {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`);
  return value.trim();
}

function httpUrl(value, name) {
  const raw = text(value, name);
  let url;
  try { url = new URL(raw); } catch { return fail(`${name} is not a URL: ${JSON.stringify(raw)}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(`${name} must be http(s), got ${url.protocol}`);
  return raw.replace(/\/+$/, "");
}

/** ssh login (`user@host` or `host`). A leading `-` would be read as an ssh option, so it is refused. */
function sshTarget(value, name) {
  const raw = text(value, name);
  if (!/^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/.test(raw)) fail(`${name} is not a plain ssh login (user@host): ${JSON.stringify(raw)}`);
  return raw;
}

function path(value, name) {
  const raw = expandHome(text(value, name));
  return isAbsolute(raw) ? raw : fail(`${name} must be an absolute path or start with ~/: ${JSON.stringify(value)}`);
}

/** The panel page's own URL. It always ends in `/`: the panel loads `api/...` relative to it, so `…/panel` would resolve beside it. */
function panelUrl(value) {
  const raw = text(value, "panelUrl");
  if (/[?#]/.test(raw)) fail("panelUrl must not contain ? or # (the plugin adds the fragment itself; tokens never go into config)");
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw.endsWith("/") ? raw : `${raw}/`;
  return `${httpUrl(raw, "panelUrl")}/`;
}

function collector(value) {
  if (value === undefined) return {};
  if (!isObject(value)) fail("collector must be an object");
  onlyKeys(value, ["roots", "since"], "collector");
  const out = {};
  if (value.roots !== undefined) {
    if (!isObject(value.roots)) fail("collector.roots must be an object {kind: [dir]}");
    out.roots = {};
    for (const [kind, dirs] of Object.entries(value.roots)) {
      if (!KINDS.includes(kind)) fail(`collector.roots.${kind}: kind must be one of ${KINDS.join(", ")}`);
      if (!Array.isArray(dirs) || dirs.some(dir => typeof dir !== "string" || dir === "")) fail(`collector.roots.${kind} must be a list of directories`);
      out.roots[kind] = dirs.map(dir => expandHome(dir));
    }
  }
  if (value.since !== undefined) {
    if (typeof value.since !== "string" && !(Number.isFinite(value.since) && value.since > 0)) fail("collector.since must be a duration like \"6h\" or milliseconds");
    out.since = value.since;
  }
  return out;
}

function upstream(value, hubUrl) {
  if (value !== undefined && !isObject(value)) fail("upstream must be an object");
  const raw = value ?? {};
  onlyKeys(raw, UPSTREAM_KEYS, "upstream");
  return {
    sshTarget: raw.sshTarget === undefined ? undefined : sshTarget(raw.sshTarget, "upstream.sshTarget"),
    url: raw.url === undefined ? hubUrl : httpUrl(raw.url, "upstream.url"),
    tokenFile: path(raw.tokenFile ?? UPSTREAM_TOKEN_FILE, "upstream.tokenFile"),
    ingestTokenFile: path(raw.ingestTokenFile ?? UPSTREAM_INGEST_TOKEN_FILE, "upstream.ingestTokenFile"),
  };
}

/** @returns normalized settings; throws an Error naming the offending key. */
export function resolveConfig(raw) {
  const config = raw ?? {};
  if (!isObject(config)) fail("the row's config must be an object");
  onlyKeys(config, KEYS, "the row's config");
  const mode = config.mode ?? "remote";
  if (mode !== "remote" && mode !== "embedded") fail(`mode must be "remote" or "embedded", got ${JSON.stringify(mode)}`);
  const port = config.httpPort ?? EMBEDDED_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`httpPort must be a TCP port, got ${JSON.stringify(port)}`);
  const hubUrl = config.hubUrl === undefined ? undefined : httpUrl(config.hubUrl, "hubUrl");
  return {
    mode,
    hubUrl,
    tokenFile: path(config.tokenFile ?? TOKEN_FILE, "tokenFile"),
    panelUrl: config.panelUrl === undefined ? undefined : panelUrl(config.panelUrl),
    upstream: upstream(config.upstream, hubUrl),
    collector: collector(config.collector),
    hostId: config.hostId === undefined ? "mac" : text(config.hostId, "hostId"),
    site: config.site === undefined ? "mac" : text(config.site, "site"),
    httpPort: port,
  };
}

const LOOPBACK_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/** The URL the browser loads for the panel: the local hub itself in embedded mode, else the edge's `/fleet/`. */
export function panelBase(settings) {
  const base = settings.panelUrl ?? (settings.mode === "embedded" ? `http://127.0.0.1:${settings.httpPort}/` : "/fleet/");
  return base.replace(/#.*$/, "");
}

/**
 * The token rides in the URL fragment (never sent to a server, never logged) when the browser reaches the hub directly on
 * loopback, or on the DSH page's own origin (a root-relative URL such as `/fleet/` behind the edge). Never for another host.
 */
export const tokenGoesInUrl = base => LOOPBACK_URL.test(base) || (base.startsWith("/") && !base.startsWith("//"));

/** `<base>#token=…&focus=<dsh session id>` */
export function panelLocation(base, { token = "", sessionId } = {}) {
  const parts = [];
  if (token !== "" && tokenGoesInUrl(base)) parts.push(`token=${encodeURIComponent(token)}`);
  if (sessionId !== undefined) parts.push(`focus=${encodeURIComponent(sessionId)}`);
  return parts.length === 0 ? base : `${base}#${parts.join("&")}`;
}

/**
 * The panel URL that carries a credential: `<base>?nonce=…` (the hub consumes it, sets the HttpOnly cookie and
 * 302s to `<base>`) plus the optional focus fragment. Same rule as tokenGoesInUrl: only loopback hubs and the
 * DSH page's own origin get one.
 */
export function panelNonceLocation(base, { nonce = "", sessionId } = {}) {
  const query = nonce === "" ? "" : `?nonce=${encodeURIComponent(nonce)}`;
  const hash = sessionId === undefined ? "" : `#focus=${encodeURIComponent(sessionId)}`;
  return `${base}${query}${hash}`;
}
