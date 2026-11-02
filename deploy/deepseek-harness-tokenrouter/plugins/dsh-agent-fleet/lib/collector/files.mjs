// file.read: bounded, redacted, read-only previews of files on this host. Credentials are never read: secret-looking
// paths (case-insensitive, also after symlink resolution), pseudo filesystems, files that turn out to be one once they
// are opened, and content holding a fleet token are refused; only regular files are returned, binary content is not
// returned and everything else passes through `redact`.
//
// The path is validated *after* the open, on the opened handle: `realpath` before `open` is a TOCTOU window (a
// directory component can be replaced by a symlink in between), so the file is opened first and its real path is
// re-derived from the handle (/proc/self/fd on Linux, realpath + dev/ino on other platforms).
import { open, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { LIMITS } from "../protocol.mjs";
import { isSecretPath, loadKnownSecrets, redact, secretContentDenial } from "../redact.mjs";
import { expandHome } from "./roots.mjs";

const SNIFF_BYTES = 8192;
const PSEUDO_FS = /^\/(?:proc|sys|dev)(?:\/|$)/;
const DELETED_SUFFIX = " (deleted)";
const SECRET_DENIED = "secret path: credentials are never previewed";

const refuse = (host, path, denied, exists = false) => ({ host, path, exists, denied });

/**
 * The path the *opened* file really has, or null when that cannot be established for this inode.
 * Linux: the target of /proc/self/fd/<fd>. Elsewhere (and where /proc is absent): `realpath` after the open, accepted
 * only when it still names the opened inode (dev/ino) — otherwise the path was swapped after the open, and the caller
 * has to refuse.
 * @param {import("node:fs/promises").FileHandle} handle
 * @param {string} requested
 * @returns {Promise<string|null>}
 */
async function openedRealPath(handle, requested) {
  if (process.platform === "linux") {
    try {
      const target = await readlink(`/proc/self/fd/${handle.fd}`);
      return target.endsWith(DELETED_SUFFIX) ? target.slice(0, -DELETED_SUFFIX.length) : target;
    } catch { /* no /proc (minimal container): fall back to realpath + inode comparison */ }
  }
  let real, info, opened;
  try {
    real = await realpath(requested);
    info = await stat(real);
    opened = await handle.stat();
  } catch { return null; }
  return info.dev === opened.dev && info.ino === opened.ino ? real : null;
}

/**
 * @param {{path: string, maxBytes?: number, host: string, home?: string, knownSecrets?: string[],
 *   hooks?: {beforeOpen?: (info: {path: string}) => unknown}}} request
 *   `knownSecrets` replaces the fleet credential values read from `home` (tests); `hooks.beforeOpen` is a test seam
 *   for the path-swap race and runs between the path check and the open.
 * @returns {Promise<import("../protocol.mjs").FilePreview>}
 */
export async function readFilePreview({ path, maxBytes, host, home = homedir(), knownSecrets, hooks } = {}) {
  if (typeof path !== "string" || path === "") return refuse(host, String(path ?? ""), "path is required");
  const requested = expandHome(path, home);
  if (!isAbsolute(requested)) return refuse(host, path, "path must be absolute");
  const abs = resolve(requested);
  if (isSecretPath(abs)) return refuse(host, abs, SECRET_DENIED);
  if (PSEUDO_FS.test(abs)) return refuse(host, abs, "pseudo filesystem");

  const cap = Math.max(1, Math.min(Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : LIMITS.fileReadBytes, LIMITS.fileReadBytes));
  await hooks?.beforeOpen?.({ path: abs });                      // test seam: swap the path between check and open

  let handle;
  try { handle = await open(abs, "r"); } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { host, path: abs, exists: false };
    if (error.code === "EISDIR") return refuse(host, abs, "is a directory", true);
    return refuse(host, abs, error.code === "EACCES" || error.code === "EPERM" ? "permission denied" : `cannot open (${error.code ?? error.message})`, true);
  }
  try {
    let info;
    try { info = await handle.stat(); } catch (error) { return refuse(host, abs, `cannot stat (${error.code ?? error.message})`, true); }
    if (!info.isFile()) return refuse(host, abs, info.isDirectory() ? "is a directory" : "not a regular file", true);

    const real = await openedRealPath(handle, abs);
    if (real === null) return refuse(host, abs, "the file changed while it was opened", true);
    if (isSecretPath(real) || PSEUDO_FS.test(real)) return refuse(host, abs, SECRET_DENIED, true);

    const buffer = Buffer.allocUnsafe(Math.min(cap, Math.max(info.size, 1)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    const preview = { host, path: abs, exists: true, size: info.size, mtime: info.mtimeMs, truncated: info.size > bytesRead };
    if (data.subarray(0, SNIFF_BYTES).includes(0)) return { ...preview, binary: true };

    let text = data.toString("utf8");
    if (preview.truncated && text.endsWith("\uFFFD")) text = text.slice(0, -1); // a multi-byte character cut by the cap
    const secrets = Array.isArray(knownSecrets) ? knownSecrets : await loadKnownSecrets({ home });
    const denial = secretContentDenial(text, secrets);
    if (denial !== null) return refuse(host, abs, denial, true);
    const masked = redact(text);
    return { ...preview, binary: false, content: masked.text, redactions: masked.count };
  } finally {
    await handle.close();
  }
}