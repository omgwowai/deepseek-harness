// Secret redaction for everything the fleet ships off a host: tool previews, prompt heads, command lines,
// file previews. Redaction runs on the collector (before data leaves the machine) and again in the hub
// for file previews read through kubectl exec. It is pattern based, so it errs towards masking.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MASK = "‹redacted›";

/** [pattern, replacement] pairs; replacements keep the key name so previews stay readable. */
const RULES = [
  // PEM blocks (private keys, certificates with keys)
  [/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY|ENCRYPTED PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g, MASK],
  // Authorization headers and bearer tokens
  [/\b(authorization\s*[:=]\s*)(?:"|')?(?:bearer|basic|token)\s+[^\s"',;]+/gi, `$1${MASK}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, `Bearer ${MASK}`],
  // Well-known token formats
  [/\bowtr_[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, MASK], // JWT
  // URL credentials: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // key=value / key: value / "key": "value" where the key names a secret
  [/((?:["']?)(?:[A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|credential|auth[_-]?token|access[_-]?key|private[_-]?key|client[_-]?secret|session[_-]?key|cookie))(?:["']?)\s*[:=]\s*)(?:"([^"\n]{4,})"|'([^'\n]{4,})'|([^\s"',;}{\]\[)(]{4,}))/gi,
    (match, prefix, dq, sq) => `${prefix}${dq !== undefined ? `"${MASK}"` : sq !== undefined ? `'${MASK}'` : MASK}`],
  // CLI flags carrying secrets: --token X, --password=X, --api-key X
  [/(--?(?:[a-z0-9-]*?(?:token|password|passwd|secret|api-key|apikey|auth-key|access-key)))(?:=|\s+)(?!-)[^\s"']+/gi, `$1 ${MASK}`],
  // kubectl/kubeconfig inline data
  [/\b((?:client-key-data|client-certificate-data|certificate-authority-data|token)\s*:\s*)[A-Za-z0-9+/=._-]{16,}/gi, `$1${MASK}`],
];

/**
 * Mask secrets in `text`. Returns the masked text and the number of replacements.
 * @param {string} text
 * @returns {{text: string, count: number}}
 */
export function redact(text) {
  if (typeof text !== "string" || text.length === 0) return { text: typeof text === "string" ? text : "", count: 0 };
  let count = 0, out = text;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === "function" ? replacement(...args) : expand(replacement, args);
    });
  }
  return { text: out, count };
}

function expand(template, args) {
  // args: match, p1, p2, ..., offset, string[, groups]
  return template.replace(/\$(\d)/g, (_, n) => args[Number(n)] ?? "");
}

/** Mask secrets and cut to `max` characters (adds "…" when cut). */
export function redactText(text, max = Infinity) {
  const { text: masked } = redact(typeof text === "string" ? text : String(text ?? ""));
  if (masked.length <= max) return masked;
  return masked.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * Paths whose content is never previewed, whatever the redaction would catch. Every rule is case-insensitive:
 * APFS (macOS) is case-insensitive by default, so `.SSH/ID_RSA` and `.ssh/id_rsa` are the same file there, and a
 * case-sensitive list would let the upper-case spelling through.
 */
const SECRET_PATHS = [
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.kube\/config$/i,
  /kubeconfig[^/]*$/i,
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.credentials\.(ya?ml|json)$/i,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|\/)(auth|token|tokens|router-api-key|api-key)(\.[a-z]+)?$/i,
  /(^|\/)cordis\.patch\.yml(\.bak[^/]*)?$/i,
  /(^|\/)\.paseo\/config\.json/i,
  /(^|\/)\.codex\/auth\.json$/i,
  /(^|\/)\.claude\/\.credentials\.json$/i,
  /(^|\/)dsh-credentials(\/|$)/i,
  /(^|\/)private(\/|$)/i,
  /(^|\/)\.config\/agent-fleet(\/|$)/i,
];

/** True when a file must not be previewed because its path suggests it holds credentials. */
export function isSecretPath(path) {
  if (typeof path !== "string") return false;
  return SECRET_PATHS.some(pattern => pattern.test(path));
}

// ── content checks ────────────────────────────────────────────────────────────────────────────────────────────────
// A path check cannot see a copy (`cp ~/.config/agent-fleet/token /tmp/notes.txt`) or a hard link, and the redaction
// rules above do not match a bare 64-hex token. Previews are therefore also compared against the fleet's own token
// values and refused when the whole file is one credential-shaped line.

/** Files under `~/.config/agent-fleet` whose contents are fleet credentials on the host doing the read. */
export const FLEET_SECRET_FILES = Object.freeze(["token", "ingest-token", "upstream-token"]);
/** Environment variables that carry the same values when a token file is not used. */
const FLEET_SECRET_ENV = Object.freeze(["AGENT_FLEET_TOKEN", "AGENT_FLEET_INGEST_TOKEN"]);
/** Values shorter than this are too likely to occur inside ordinary text. */
export const MIN_SECRET_LENGTH = 16;
/** A bare credential is short: a lone line of data (a minified file, a long log line) is not one. */
const LONE_HEX = /^(?:[0-9a-f]{64}|[0-9a-f]{128})$/i;
const LONE_BASE64 = /^[A-Za-z0-9+/=_-]{128,1024}$/;

/**
 * The fleet credential values that exist on this host: the hub API token, the ingest token and the upstream tokens,
 * read from `~/.config/agent-fleet/<name>` (and the token environment variables). Missing or unreadable files are
 * skipped — the host may not run a hub.
 * @param {{home?: string, dir?: string, env?: Record<string, string | undefined>}} [options]
 * @returns {Promise<string[]>}
 */
export async function loadKnownSecrets({ home = homedir(), dir = join(home, ".config", "agent-fleet"), env = process.env } = {}) {
  const values = new Set();
  for (const name of FLEET_SECRET_FILES) {
    let text;
    try { text = await readFile(join(dir, name), "utf8"); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (value.length >= MIN_SECRET_LENGTH) values.add(value);
    }
  }
  for (const name of FLEET_SECRET_ENV) {
    const value = String(env?.[name] ?? "").trim();
    if (value.length >= MIN_SECRET_LENGTH) values.add(value);
  }
  return [...values];
}

/** True when `text` contains one of `values` verbatim. */
export function containsKnownSecret(text, values) {
  if (typeof text !== "string" || text.length === 0 || !Array.isArray(values)) return false;
  return values.some(value => typeof value === "string" && value.length >= MIN_SECRET_LENGTH && text.includes(value));
}

/**
 * True when the preview is nothing but one credential-shaped line: a lone 64- or 128-character hex token or a long
 * base64 blob. Files with line breaks, spaces or ordinary punctuation (source, JSON, logs) are not affected.
 */
export function looksLikeBareSecret(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return false;
  return LONE_HEX.test(trimmed) || LONE_BASE64.test(trimmed);
}

/**
 * Reason to refuse a preview of `text`, or null when it may be shown (after `redact`). Set `denied` on the preview.
 * @param {string} text
 * @param {string[]} [values]  known fleet credential values, e.g. from `loadKnownSecrets`
 * @returns {string|null}
 */
export function secretContentDenial(text, values = []) {
  if (containsKnownSecret(text, values)) return "secret content: contains a fleet credential";
  if (looksLikeBareSecret(text)) return "secret content: looks like a bare credential";
  return null;
}
