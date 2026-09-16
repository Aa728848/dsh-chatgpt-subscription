/**
 * Sync this plugin's bundled agent presets into the harness-home preset root.
 *
 * DSH discovers agent presets only from configured roots, the shipped
 * `agent-presets` package's own `presets/` directory, and
 * `<dshHome>/.agent-presets`. A plugin package cannot register a root by
 * existing, so the way a preset travels with an npm install is to ship the
 * directory inside the package and copy it into the harness-home root at
 * startup — the same arrangement `@linxin666/dsh-liangshen` uses.
 *
 * Copy is per-preset-directory and idempotent: a target tree byte-identical to
 * the bundled one is skipped, otherwise the whole tree is copied and any
 * target-only files are pruned. Preset ids listed in `retire` are removed
 * when the bundle no longer ships them. Directories this plugin does not own —
 * presets the user wrote by hand, or another plugin's — are never touched.
 *
 * `fs.cpSync({ recursive: true })` is deliberately avoided: on Node 22 for
 * Windows it can abort the process with STATUS_STACK_BUFFER_OVERRUN when the
 * source path contains non-ASCII characters (nodejs/node#54476). The copy is
 * per-entry instead, which also lets source mtimes ride along.
 * @module dsh-chatgpt-subscription/preset-sync
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The preset directory this package ships. */
export const BUNDLED_PRESET_IDS: readonly string[] = ['dispatch']

/** Clock tolerance for the mtime fast path before falling through to a byte compare. */
const MTIME_TOLERANCE_MS = 1000

/** One sync run's outcome, grouped for diagnostics. */
export interface PresetSyncResult {
  /** Preset ids whose tree was (re)written this run. */
  synced: string[]
  /** Preset ids already current — nothing copied. */
  current: string[]
  /** Preset ids that failed, with the underlying error message. */
  failed: { id: string; error: string }[]
  /** Previously bundled preset ids removed from the target root this run. */
  retired: string[]
}

/**
 * The package root, found by walking up from this module to the nearest
 * `package.json`.
 *
 * A fixed `../presets/` is wrong here: this module sits two levels below the
 * package root under `src/host/` but is bundled flat into `lib/`, so the same
 * relative specifier resolves to a different directory in each layout. Walking
 * up is layout-independent — it holds under `src/`, under the bundled
 * `lib/`, and when the package is reached through a pnpm symlink or a
 * Windows junction.
 * @returns absolute package root path.
 */
export function packageRoot(): string {
  let dir = fileURLToPath(new URL('.', import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('dsh-chatgpt-subscription: could not locate the package root')
    dir = parent
  }
}

/** Absolute path of the `presets/` directory shipped inside this package. */
export function bundledPresetsRoot(): string {
  return join(packageRoot(), 'presets')
}

/** The harness-home agent-presets discovery root this plugin syncs into. */
export function presetTargetRoot(home: string): string {
  return join(home, '.agent-presets')
}

/** Every file below `root`, as absolute paths. */
function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(path)
    }
  }
  walk(root)
  return out
}

/**
 * Whether two files are byte-identical. Size and mtime only rule a pair out
 * cheaply; an equal size and close mtime still fall through to a byte compare
 * so a content difference is never missed.
 */
function sameFile(a: string, b: string): boolean {
  const sourceStat = statSync(a)
  const targetStat = statSync(b)
  if (sourceStat.size !== targetStat.size) return false
  if (Math.abs(sourceStat.mtimeMs - targetStat.mtimeMs) > MTIME_TOLERANCE_MS) return false
  return readFileSync(a).equals(readFileSync(b))
}

/** Remove target files not in `keep`, then directories those removals emptied. */
function pruneExtras(root: string, keep: ReadonlySet<string>): void {
  const parents = new Set<string>()
  for (const file of filesUnder(root)) {
    if (!keep.has(relative(root, file))) {
      parents.add(dirname(file))
      rmSync(file, { force: true })
    }
  }
  for (const start of parents) {
    let dir: string | undefined = start
    while (dir !== undefined && relative(root, dir) !== '') {
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true })
        dir = dirname(dir)
      } else {
        dir = undefined
      }
    }
  }
}

/** Copy the tree under `sourceDir` into `targetDir`, creating it as needed. */
function copyTreeSync(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir)) {
    const source = join(sourceDir, entry)
    const target = join(targetDir, entry)
    const stat = statSync(source)
    if (stat.isDirectory()) {
      copyTreeSync(source, target)
    } else {
      copyFileSync(source, target)
      utimesSync(target, stat.atime, stat.mtime)
    }
  }
}

/**
 * Copy `sourceDir` into `targetDir` idempotently.
 * @param sourceDir - bundled preset directory.
 * @param targetDir - discovery-root directory for the same preset id.
 * @returns whether anything was written.
 */
export function syncOnePreset(sourceDir: string, targetDir: string): 'synced' | 'current' {
  const sourceFiles = filesUnder(sourceDir)
  const sourceSet = new Set(sourceFiles.map(file => relative(sourceDir, file)))

  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  if (!existsSync(targetDir)) {
    copyTreeSync(sourceDir, targetDir)
    pruneExtras(targetDir, sourceSet)
    return 'synced'
  }

  let dirty = false
  for (const file of sourceFiles) {
    const dest = join(targetDir, relative(sourceDir, file))
    if (!existsSync(dest) || !sameFile(file, dest)) {
      dirty = true
      break
    }
  }
  if (!dirty) {
    for (const file of filesUnder(targetDir)) {
      if (!sourceSet.has(relative(targetDir, file))) {
        dirty = true
        break
      }
    }
  }
  if (!dirty) return 'current'

  // Drop target-only entries first so a file/dir type clash never reaches the copy.
  pruneExtras(targetDir, sourceSet)
  copyTreeSync(sourceDir, targetDir)
  pruneExtras(targetDir, sourceSet)
  return 'synced'
}

/**
 * Sync every bundled preset into `targetRoot`, then remove ids named in
 * `retire` that the bundle no longer ships. Only those exact ids are removed;
 * every other target directory is left alone.
 * @param sourceRoot - this package's bundled `presets/` directory.
 * @param targetRoot - harness-home agent-presets discovery root.
 * @param retire - previously bundled preset ids to remove when absent from the source.
 * @returns the grouped outcome of the run.
 */
export function syncPresetTrees(
  sourceRoot: string,
  targetRoot: string,
  retire: readonly string[] = [],
): PresetSyncResult {
  const result: PresetSyncResult = { synced: [], current: [], failed: [], retired: [] }
  if (!existsSync(sourceRoot)) return result
  mkdirSync(targetRoot, { recursive: true })

  const shipped = new Set<string>()
  for (const entry of readdirSync(sourceRoot)) {
    const source = join(sourceRoot, entry)
    if (!statSync(source).isDirectory()) continue
    const id = basename(source)
    shipped.add(id)
    try {
      const outcome = syncOnePreset(source, join(targetRoot, id))
      if (outcome === 'synced') result.synced.push(id)
      else result.current.push(id)
    } catch (error) {
      result.failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  for (const id of retire) {
    if (shipped.has(id)) continue
    const stale = join(targetRoot, id)
    if (!existsSync(stale)) continue
    try {
      rmSync(stale, { recursive: true, force: true })
      result.retired.push(id)
    } catch (error) {
      result.failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
