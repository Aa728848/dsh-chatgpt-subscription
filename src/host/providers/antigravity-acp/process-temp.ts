/**
 * Per-process temporary storage for the official Antigravity executable.
 *
 * The standalone Windows server is a PyInstaller onefile: it unpacks a large
 * `_MEI` tree beneath TMP/TEMP and removes that tree itself during a graceful
 * exit. Keeping every launch under DSH's own cache prevents a killed or polled
 * process from writing into the user's system TEMP. Cleanup here is deliberately
 * non-recursive: only the empty run directory owned by this module is removed.
 */
import { mkdirSync, mkdtempSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import { dshHomeDir } from '../../common/home.ts'

export interface AcpProcessTemp {
  /** Private directory passed through TMP, TEMP and TMPDIR. */
  directory: string
  /** Credential-scrubbed environment containing the isolated temp overrides. */
  environment: NodeJS.ProcessEnv
  /** Remove the run directory only when it is empty; never remove its contents. */
  release(): void
}

/** Create one launch's temporary directory beneath DSH's ACP process cache. */
export function createAcpProcessTemp(tempRoot?: string): AcpProcessTemp {
  const root = tempRoot ?? path.join(dshHomeDir(), 'cache', 'antigravity-acp', 'process-tmp')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(path.join(root, 'run-'))
  return {
    directory,
    environment: isolatedTempEnvironment(directory),
    release: () => {
      try {
        rmdirSync(directory)
      } catch {
        // A live or killed onefile may still own files here. Its owner, not a
        // recursive host-side delete, is responsible for those files.
      }
    },
  }
}

/** Redirect every PyInstaller-supported temp variable to this launch's directory. */
function isolatedTempEnvironment(directory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/key|token|secret|password|credential/i.test(key)) continue
    // Windows environment names are case-insensitive. An inherited Temp/tmp
    // variant must not win over the explicit entries below.
    if (/^(?:tmp|temp|tmpdir)$/i.test(key)) continue
    environment[key] = value
  }
  environment.TMP = directory
  environment.TEMP = directory
  environment.TMPDIR = directory
  return environment
}
