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
 *
 * A preset row names the package it mounts, so a name the running installation
 * does not ship makes the whole preset unresolvable. Text naming a package the
 * harness renamed is therefore reconciled with the installation before it is
 * compared or written.
 * @module dsh-chatgpt-subscription/preset-sync
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The preset directory this package ships. */
export const BUNDLED_PRESET_IDS: readonly string[] = ['dispatch']

/** Clock tolerance for the mtime fast path before falling through to a byte compare. */
const MTIME_TOLERANCE_MS = 1000

/** Extensions whose text may name a package. */
const REWRITABLE_EXTENSIONS: readonly string[] = ['.yml', '.yaml']

/**
 * Package names the harness renamed, mapped to the name that replaced each.
 *
 * Harness 0.1.6 renamed `workflow-worker-thread` to `workflow-ptc`; every
 * earlier release ships only the former. The bundled preset carries the
 * earlier spelling, which the sync replaces when the installation ships the
 * later one.
 */
const RENAMED_PACKAGES: ReadonlyMap<string, string> = new Map([
  ['@deepseek-ai/dsh-workflow-worker-thread', '@deepseek-ai/dsh-workflow-ptc'],
])

/**
 * Whether a bare specifier resolves from this module in the running
 * installation. A harness whose Node build exposes no `import.meta.resolve`
 * answers `false` for everything, which leaves every bundled spelling in place.
 * @param specifier - bare package specifier.
 * @returns whether the specifier resolves.
 */
export function resolvesFromHere(specifier: string): boolean {
  const resolve = (import.meta as { resolve?: (specifier: string) => unknown }).resolve
  if (resolve === undefined) return false
  try {
    resolve(specifier)
    return true
  } catch {
    return false
  }
}

/**
 * Point every renamed package name at the spelling this installation ships.
 *
 * A name that still resolves is left alone, and so is a rename whose
 * replacement does not resolve: with neither spelling present the preset is
 * unresolvable either way, and rewriting would only hide which name was tried.
 * @param content - bundled preset file text.
 * @param resolves - whether a bare specifier resolves in this installation.
 * @returns the text to write, equal to `content` when no rename applies.
 */
export function reconcilePackageNames(content: string, resolves: (specifier: string) => boolean): string {
  let out = content
  for (const [renamed, current] of RENAMED_PACKAGES) {
    if (!out.includes(renamed)) continue
    if (resolves(renamed) || !resolves(current)) continue
    out = out.split(renamed).join(current)
  }
  return out
}

/** One preset file's text, rewritten for the running installation. */
export type PresetFileRewrite = (relativePath: string, content: string) => string

/** Rewrite bundled preset text to the package spellings this installation ships. */
export const rewritePresetFile: PresetFileRewrite = (_relativePath, content) =>
  reconcilePackageNames(content, resolvesFromHere)

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
 * Text files below `sourceDir` whose content `rewrite` changes, keyed by path
 * relative to `sourceDir`.
 * @param sourceDir - bundled preset directory.
 * @param rewrite - text rewrite for the running installation.
 * @returns replacement text per changed file.
 */
function collectRewrites(sourceDir: string, rewrite: PresetFileRewrite): Map<string, string> {
  const rewrites = new Map<string, string>()
  for (const file of filesUnder(sourceDir)) {
    if (!REWRITABLE_EXTENSIONS.some(extension => file.endsWith(extension))) continue
    const content = readFileSync(file, 'utf8')
    const rewritten = rewrite(relative(sourceDir, file), content)
    if (rewritten !== content) rewrites.set(relative(sourceDir, file), rewritten)
  }
  return rewrites
}

/** Write the replacement text of every rewritten file below `targetDir`. */
function writeRewrites(targetDir: string, rewrites: ReadonlyMap<string, string>): void {
  for (const [rel, content] of rewrites) writeFileSync(join(targetDir, rel), content)
}

/**
 * Copy `sourceDir` into `targetDir` idempotently.
 * @param sourceDir - bundled preset directory.
 * @param targetDir - discovery-root directory for the same preset id.
 * @param rewrites - replacement text by path relative to `sourceDir`; a rewritten file is compared by content, since its target carries no source mtime.
 * @returns whether anything was written.
 */
export function syncOnePreset(
  sourceDir: string,
  targetDir: string,
  rewrites: ReadonlyMap<string, string> = new Map(),
): 'synced' | 'current' {
  const sourceFiles = filesUnder(sourceDir)
  const sourceSet = new Set(sourceFiles.map(file => relative(sourceDir, file)))

  if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  if (!existsSync(targetDir)) {
    copyTreeSync(sourceDir, targetDir)
    writeRewrites(targetDir, rewrites)
    pruneExtras(targetDir, sourceSet)
    return 'synced'
  }

  let dirty = false
  for (const file of sourceFiles) {
    const rel = relative(sourceDir, file)
    const dest = join(targetDir, rel)
    const replacement = rewrites.get(rel)
    if (replacement !== undefined) {
      if (!existsSync(dest) || readFileSync(dest, 'utf8') !== replacement) {
        dirty = true
        break
      }
      continue
    }
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
  writeRewrites(targetDir, rewrites)
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
 * @param rewrite - rewrites preset text for the running installation; omission copies the bundle verbatim.
 * @returns the grouped outcome of the run.
 */
export function syncPresetTrees(
  sourceRoot: string,
  targetRoot: string,
  retire: readonly string[] = [],
  rewrite?: PresetFileRewrite,
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
      const rewrites = rewrite === undefined ? new Map<string, string>() : collectRewrites(source, rewrite)
      const outcome = syncOnePreset(source, join(targetRoot, id), rewrites)
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
