// Hub authentication: the token file (0600, 64 hex), constant-time comparison, the cookie exchanges behind
// `GET /?token=…` and `GET /?nonce=…`, and the Host header policy. The panel shell is public (it holds no fleet
// data); every API route except /api/health needs the token as `Authorization: Bearer`, `x-agent-fleet-token` or
// the cookie. Unauthenticated /api/health answers liveness only (`{ok, version}`): the panel, upstream and kube
// state behind the full body is for token holders.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const COOKIE_NAME = "agent_fleet";
export const TOKEN_HEADER = "x-agent-fleet-token";
/** Lifetime of a panel-session nonce (`POST /api/session-nonce` → `GET /?nonce=…`): one navigation, no longer. */
export const NONCE_TTL_MS = 60_000;
const NONCE_LIMIT = 64;

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
 * @param {number} [options.nonceTtlMs]     panel-session nonce lifetime (default 60 s)
 * @param {number} [options.nonceLimit]     how many unconsumed nonces the hub keeps (oldest go first)
 * @param {() => number} [options.now]
 */
export function createAuth({ token, publicHosts = [], nonceTtlMs = NONCE_TTL_MS, nonceLimit = NONCE_LIMIT, now = Date.now }) {
  if (typeof token !== "string" || token === "") throw new TypeError("createAuth: token is required");
  if (!(Number.isFinite(nonceTtlMs) && nonceTtlMs > 0)) throw new TypeError("createAuth: nonceTtlMs must be a positive number");
  if (!(Number.isInteger(nonceLimit) && nonceLimit >= 1)) throw new TypeError("createAuth: nonceLimit must be a positive integer");
  const allowedHosts = new Set([...LOOPBACK_HOSTS, ...publicHosts.map(hostName)]);
  const pending = new Map();                                        // nonce → expiresAt; single use, capped
  return {
    /** True when the request carries the token in a header or the cookie. */
    authenticate(request) { return presented(request).some(candidate => safeEqual(candidate, token)); },
    /** True when `candidate` (the `?token=` of a cookie exchange) is the token. */
    accepts(candidate) { return safeEqual(candidate, token); },
    /** Set-Cookie value of the exchange. */
    cookie() { return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`; },
    /**
     * A one-time URL credential for the panel's cookie exchange (`POST /api/session-nonce` → `GET /?nonce=…`).
     * The raw token never reaches a URL, a fragment or page storage this way.
     */
    mintNonce() {
      const at = now();
      for (const [nonce, expiresAt] of pending) if (expiresAt <= at) pending.delete(nonce);
      while (pending.size >= nonceLimit) pending.delete(pending.keys().next().value);
      const minted = randomBytes(24).toString("base64url");
      pending.set(minted, at + nonceTtlMs);
      return { nonce: minted, expiresAt: at + nonceTtlMs };
    },
    /** Consumes a nonce: true exactly once, and only while it has not expired. */
    consumeNonce(nonce) {
      if (typeof nonce !== "string" || nonce === "") return false;
      const expiresAt = pending.get(nonce);
      if (expiresAt === undefined) return false;
      pending.delete(nonce);
      return expiresAt > now();
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
