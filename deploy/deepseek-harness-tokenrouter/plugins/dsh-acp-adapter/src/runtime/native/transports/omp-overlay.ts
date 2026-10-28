/**
 * The configuration overlay the OMP transport hands to its own `omp` process.
 *
 * omp continues an active goal by itself only in the run modes listed in `goal.continuationModes`, and the default is
 * `["interactive"]`: over rpc (`--mode rpc-ui`, how DSH runs omp) a goal would never continue. The transport therefore
 * passes `--config <overlay>` that adds `rpc`; `interactive` stays, as in omp's own default.
 *
 * What the file has to be follows from how omp reads `--config` (`Settings#loadOverlayYaml`, `#mergeOwnLayers`):
 * - every file is read strictly: a missing or malformed one stops omp at startup, so the file is created before the
 *   process is spawned and holds nothing but valid YAML;
 * - the files are merged in the order given, later over earlier key by key (an array is replaced whole), and the result
 *   goes over the user's global and project settings. The overlay is passed last, so it also wins over a `--config`
 *   the launcher passes, and over `PI_CONFIG_FILES` (omp reads those first);
 * - omp watches the file's directory and reloads on change, so the file lives in a private directory of its own and is
 *   removed only once the process is gone.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** `rpc` added to omp's default `["interactive"]`. */
export const OMP_GOAL_OVERLAY = 'goal:\n  continuationModes: [interactive, rpc]\n'

export interface OmpConfigOverlay {
  /** The file to pass as `--config`. */
  readonly file: string
  /** Deletes the overlay's directory; the process that read it must be gone. */
  remove(): Promise<void>
}

/**
 * Writes the overlay into a fresh directory below `root` (created when missing). `mkdtemp` makes the directory readable by
 * its owner only, and the file is too, so no other user of the machine can swap in settings of their own.
 */
export async function createOmpConfigOverlay(root: string): Promise<OmpConfigOverlay> {
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'dsh-acp-omp-'))
  const file = join(dir, 'overlay.yml')
  try {
    await writeFile(file, OMP_GOAL_OVERLAY, { mode: 0o600 })
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return { file, remove: () => rm(dir, { recursive: true, force: true }) }
}
