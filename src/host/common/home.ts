import os from 'node:os'
import path from 'node:path'

/**
 * The harness home directory every plugin store lives under.
 *
 * Shared by every provider line and by the pool core, so a single env override
 * (`DSH_HOME`) redirects all of them at once.
 */
export function dshHomeDir(): string {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
}
