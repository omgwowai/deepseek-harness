// Hub authentication: the token file (0600, 64 hex), constant-time comparison, the panel credentials (the one-time
// nonce of the plugin's panel URL and the session key the panel redeems it for), the cookie exchange behind
// `GET /?token=…`, and the Host header policy. The panel shell is public (it holds no fleet data); every API route
// except /api/health and the nonce redemption needs the token or a panel session key as `Authorization: Bearer`,
// `x-agent-fleet-token` or the cookie. Unauthenticated /api/health answers liveness only (`{ok, version}`): the
// panel, upstream and kube state behind the full body is for token holders.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const COOKIE_NAME = "agent_fleet";
export const TOKEN_HEADER = "x-agent-fleet-token";
export const NONCE_HEADER = "x-agent-fleet-nonce";
/** Lifetime of a panel nonce (`POST /api/session-nonce` → the panel URL's `#nonce=` → `POST /api/session`): one page load. */
export const NONCE_TTL_MS = 60_000;
const NONCE_LIMIT = 64;
const SESSION_LIMIT = 256;

const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

export const defaultTokenFile = () => join(homedir(), ".config", "agent-fleet", "token");

function readToken(file) {
  let text;
  try { text = readFileSync(file, "utf8").trim(); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!TOKEN_SHAPE.test(text)) return null;
  try { if (statSync(file).mode & 0o077) chmodSync(file, 0o600); } catch { /* not ours to fix */ }
  return text;
}

/** Contents of the token file; creates it (mode 0600, 64 hex characters) when it is missing or empty. */
export function loadToken(file = defaultTokenFile()) {
  const existing = readToken(file);
  if (existing !== null) return existing;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  try {
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = readToken(file);                      // another process created it first
    if (raced !== null) return raced;
    writeFileSync(file, `${token}\n`, { mode: 0o600 }); // exists but empty or garbled
  }
  chmodSync(file, 0o600);
  return token;
}

/** Constant-time string comparison; hashing first hides the length of the secret too. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Host name of a Host header value, lower-cased, without port (IPv6 literals keep their brackets). */
function hostName(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text.startsWith("[")) { const end = text.indexOf("]"); return end < 0 ? text : text.slice(0, end + 1); }
  return text.replace(/:\d+$/, "");
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || (typeof address === "string" && address.startsWith("::ffff:127."));
}

/** Credentials a request carries, in the order they are tried. */
function presented(request) {
  const found = [];
  const authorization = request.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match) found.push(match[1]);
  }
  const header = request.headers[TOKEN_HEADER];
  if (typeof header === "string" && header.trim() !== "") found.push(header.trim());
  const cookie = request.headers.cookie;
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === COOKIE_NAME) {
        const raw = part.slice(eq + 1).trim();
        try { found.push(decodeURIComponent(raw)); } catch { found.push(raw); }
      }
    }
  }
  return found;
}

/**
 * @param {object} options
 * @param {string} options.token
 * @param {string[]} [options.publicHosts]  host names (no port) besides loopback that may appear in the Host header
 * @param {number} [options.nonceTtlMs]     panel nonce lifetime (default 60 s)
 * @param {number} [options.nonceLimit]     how many unredeemed nonces the hub keeps (oldest go first)
 * @param {number} [options.sessionLimit]   how many panel session keys the hub keeps (least recently used go first)
 * @param {() => number} [options.now]
 */
export function createAuth({ token, publicHosts = [], nonceTtlMs = NONCE_TTL_MS, nonceLimit = NONCE_LIMIT, sessionLimit = SESSION_LIMIT, now = Date.now }) {
  if (typeof token !== "string" || token === "") throw new TypeError("createAuth: token is required");
  if (!(Number.isFinite(nonceTtlMs) && nonceTtlMs > 0)) throw new TypeError("createAuth: nonceTtlMs must be a positive number");
  if (!(Number.isInteger(nonceLimit) && nonceLimit >= 1)) throw new TypeError("createAuth: nonceLimit must be a positive integer");
  if (!(Number.isInteger(sessionLimit) && sessionLimit >= 1)) throw new TypeError("createAuth: sessionLimit must be a positive integer");
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...publicHosts.map(hostName)]);
  const pending = new Map();                                        // nonce → expiresAt; single use, capped
  const sessions = new Set();                                       // sha256 of the panel session keys, least recently used first
  const digest = value => createHash("sha256").update(value).digest("base64url");
  function consumeNonce(nonce) {
    if (typeof nonce !== "string" || nonce === "") return false;
    const expiresAt = pending.get(nonce);
    if (expiresAt === undefined) return false;
    pending.delete(nonce);
    return expiresAt > now();
  }
  /** Looked up by digest, so the lookup's timing says nothing about a key. A key in use moves to the back, so the cap evicts the panels that stopped asking. */
  function liveSession(candidate) {
    const hashed = digest(candidate);
    if (!sessions.has(hashed)) return false;
    sessions.delete(hashed);
    sessions.add(hashed);
    return true;
  }
  return {
    /** True when the request carries the token or a panel session key, in a header or the cookie. */
    authenticate(request) { return presented(request).some(candidate => safeEqual(candidate, token) || liveSession(candidate)); },
    /** True when the request carries the token itself, not a panel session key: minting a nonce takes this. */
    holdsToken(request) { return presented(request).some(candidate => safeEqual(candidate, token)); },
    /** True when `candidate` (the `?token=` of a cookie exchange) is the token. */
    accepts(candidate) { return safeEqual(candidate, token); },
    /** Set-Cookie value of the exchanges. */
    cookie() { return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`; },
    /**
     * The one-time credential of the plugin's panel URL (`POST /api/session-nonce`, carried as `#nonce=…`): the raw
     * token never reaches a URL, a fragment or the page this way.
     */
    mintNonce() {
      const at = now();
      for (const [nonce, expiresAt] of pending) if (expiresAt <= at) pending.delete(nonce);
      while (pending.size >= nonceLimit) pending.delete(pending.keys().next().value);
      const minted = randomBytes(24).toString("base64url");
      pending.set(minted, at + nonceTtlMs);
      return { nonce: minted, expiresAt: at + nonceTtlMs };
    },
    /**
     * Redeems a panel nonce (`POST /api/session`, exactly once, before it expires) for a session key. The panel keeps
     * the key in memory and sends it as a header, which also works in an iframe of another site, where the browser
     * drops the SameSite cookie (the desktop app embeds the loopback hub in dsh-app://). A key lives until the hub
     * restarts or the cap evicts it. Null when the nonce is unknown, spent or expired.
     */
    openSession(nonce) {
      if (!consumeNonce(nonce)) return null;
      while (sessions.size >= sessionLimit) sessions.delete(sessions.values().next().value);
      const key = randomBytes(24).toString("base64url");
      sessions.add(digest(key));
      return key;
    },
    /**
     * DNS-rebinding guard: loopback names and the configured public hosts only. `x-forwarded-host` is the name the
     * (loopback) edge saw; accepting it opens nothing the Host header would not, so a browser that resolves
     * evil.example at this machine still gets 403.
     */
    hostAllowed(request) {
      const host = request.headers.host;
      if (typeof host !== "string" || host === "") return true;      // HTTP/1.0 or a raw client: not a browser
      if (allowedHosts.has(hostName(host))) return true;
      const forwarded = request.headers["x-forwarded-host"];
      return typeof forwarded === "string" && isLoopbackAddress(request.socket?.remoteAddress) && allowedHosts.has(hostName(forwarded));
    },
  };
}
