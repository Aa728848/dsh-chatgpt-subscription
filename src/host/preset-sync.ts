/**
 * Get this plugin's bundled agent presets in front of the running harness:
 * either declared at runtime, or copied into the harness-home preset root.
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
 *
 * Harness 0.1.7 stopped reading that root and takes presets from a plugin row
 * instead, which this package declares at runtime
 * (`src/host/agent-preset.ts`, because shipping the row itself would break the
 * generations that do not have it). {@link installBundledPresets} is the one
 * entry point for both mechanisms: it copies the tree only when that runtime
 * declaration was unavailable, so a harness that reads no discovery root is
 * never written to.
 * @module dsh-chatgpt-subscription/preset-sync
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PresetHost, PresetInstall } from './agent-preset.ts'

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
 * Packages whose row some supported harness generation does not ship at all.
 *
 * An enabled row naming a package the installation cannot resolve makes the
 * whole preset unresolvable — the roster reports it broken, which is worse than
 * a missing row because a broken preset can be neither selected nor copied. The
 * roster skips a `disabled` row in that check, so the sync disables a row whose
 * package is absent, and the next boot that ships the package re-enables it.
 *
 * The set is deliberately explicit rather than "every row that fails to
 * resolve": a resolver that fails on a working installation would then strip
 * the preset down to nothing, a quieter failure than the one it fixes.
 */
const OPTIONALLY_ABSENT_PACKAGES: readonly string[] = [
  // Published from harness 0.1.5-alpha.2; the shipped `ptc` preset gained this
  // row in 0.1.5-rc.1, the shape this preset was written against.
  '@deepseek-ai/dsh-tool-present',
]

/**
 * Harness home directory, matching the host's resolution.
 */
function dshHomeDir(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * The harness entry script's directory, when this process is the harness.
 *
 * The harness keeps its own packages in the `node_modules` tree of its
 * installation — a global npm prefix, an npx cache, or a checkout — which no
 * profile directory, cwd, or plugin package root necessarily reaches: the
 * plugin lives in the profile's own dependency tree, and Node resolution from
 * here never crosses into the harness's. The CLI entry script always sits
 * inside that tree, so its directory is the one candidate guaranteed to reach
 * the packages the harness ships. Symlinks are resolved because an npm bin
 * shim may point into the tree from outside it.
 * @param entryScript - `process.argv[1]` of the running harness.
 * @returns the entry script's real directory, or `undefined` when there is none.
 */
function harnessEntryDir(entryScript: string | undefined): string | undefined {
  if (!entryScript) return undefined
  const absolute = resolve(entryScript)
  try {
    return dirname(realpathSync(absolute))
  } catch {
    return dirname(absolute)
  }
}

/**
 * Candidate directories where the running harness or profile packages reside.
 * @param entryScript - harness CLI entry script, defaults to this process's.
 */
export function candidatePackageRoots(entryScript: string | undefined = process.argv[1]): string[] {
  const roots = new Set<string>()
  const entryDir = harnessEntryDir(entryScript)
  if (entryDir !== undefined) roots.add(entryDir)
  const home = dshHomeDir()
  const profilesDir = join(home, 'profiles')
  if (existsSync(profilesDir)) {
    roots.add(profilesDir)
    try {
      for (const entry of readdirSync(profilesDir)) {
        const full = join(profilesDir, entry)
        try {
          if (statSync(full).isDirectory()) roots.add(full)
        } catch {}
      }
    } catch {}
  }
  try {
    const cwd = process.cwd()
    if (cwd) roots.add(cwd)
  } catch {}
  try {
    roots.add(packageRoot())
  } catch {}
  return [...roots]
}

/**
 * Whether a package is installed in any candidate node_modules tree.
 * Matches DSH agent-presets' own discovery check.
 */
export function packageInstalled(
  specifier: string,
  roots: readonly string[] = candidatePackageRoots(),
): boolean {
  const pkg = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
  for (const root of roots) {
    let dir = root
    for (;;) {
      if (existsSync(join(dir, 'node_modules', pkg, 'package.json'))) return true
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return false
}

/**
 * Whether a bare specifier resolves from this module in the running
 * installation. A harness whose Node build exposes no `import.meta.resolve`
 * or whose plugin is executed from outside the profile tree falls through to
 * checking candidate `node_modules` trees across the running harness home.
 * @param specifier - bare package specifier.
 * @returns whether the specifier resolves.
 */
export function resolvesFromHere(specifier: string): boolean {
  const resolve = (import.meta as { resolve?: (specifier: string) => unknown }).resolve
  if (resolve !== undefined) {
    try {
      resolve(specifier)
      return true
    } catch {
      // Fall through to checking installed packages across the running harness home
    }
  }
  return packageInstalled(specifier)
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
    if (out.includes(renamed) && !resolves(renamed) && resolves(current)) {
      out = out.split(renamed).join(current)
    } else if (out.includes(current) && !resolves(current) && resolves(renamed)) {
      out = out.split(current).join(renamed)
    }
  }
  return out
}

/** Leading spaces of one line — the indentation its YAML keys share. */
function indentationOf(line: string): number {
  return line.length - line.trimStart().length
}

/** The package a row line mounts, when the line is a row's `name:` key. */
function rowPackageName(line: string): string | undefined {
  return /^\s*name:\s*'([^']+)'\s*$/.exec(line)?.[1]
}

/** Whether the row whose `name:` key sits at `index` already declares `disabled`. */
function rowDeclaresDisabled(lines: readonly string[], index: number): boolean {
  const indent = indentationOf(lines[index] ?? '')
  // The row's own keys sit at the name key's indentation: a deeper line belongs
  // to a nested value, a shallower one starts the next row.
  for (const line of lines.slice(index + 1)) {
    if (line.trim() === '') continue
    const own = indentationOf(line)
    if (own < indent) return false
    if (own === indent && line.trimStart().startsWith('disabled:')) return true
  }
  return false
}

/**
 * Disable every row whose package this installation does not ship.
 * @param content - preset file text.
 * @param resolves - whether a bare specifier resolves in this installation.
 * @returns the text to write, equal to `content` when no row is affected.
 */
function disableRowsForAbsentPackages(content: string, resolves: (specifier: string) => boolean): string {
  const lines = content.split('\n')
  const out: string[] = []
  for (const [index, line] of lines.entries()) {
    out.push(line)
    const specifier = rowPackageName(line)
    if (specifier === undefined || !OPTIONALLY_ABSENT_PACKAGES.includes(specifier)) continue
    if (resolves(specifier) || rowDeclaresDisabled(lines, index)) continue
    out.push(`${' '.repeat(indentationOf(line))}disabled: true`)
  }
  return out.join('\n')
}

/**
 * Reconcile one bundled preset file with the packages this installation ships:
 * a renamed package takes the spelling it carries, and a row it cannot mount is
 * disabled rather than left to mark the whole preset unresolvable.
 * @param content - bundled preset file text.
 * @param resolves - whether a bare specifier resolves in this installation.
 * @returns the text to write.
 */
export function reconcilePreset(content: string, resolves: (specifier: string) => boolean): string {
  return disableRowsForAbsentPackages(reconcilePackageNames(content, resolves), resolves)
}

/** One preset file's text, rewritten for the running installation. */
export type PresetFileRewrite = (relativePath: string, content: string) => string

/** Rewrite bundled preset text for the packages this installation ships. */
export const rewritePresetFile: PresetFileRewrite = (_relativePath, content) =>
  reconcilePreset(content, resolvesFromHere)

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

/**
 * Make this package's bundled agent presets available on the running harness.
 *
 * The harness-home copy is the mechanism for every generation before 0.1.7,
 * and the fallback for one whose runtime declaration is missing or unusable.
 * It is skipped entirely when the declaration already took the presets: a
 * harness that registers presets from a plugin row reads no discovery root, so
 * the copy would write files nothing reads.
 * @param host - plugin context: the effect seam and the logger.
 * @param install - what the runtime declaration attempt reported.
 * @returns the effect body's disposer, for `ctx.effect`.
 */
export function installBundledPresets(host: PresetHost, install: PresetInstall): () => void {
  if (install === 'registered') return () => undefined
  try {
    const target = presetTargetRoot(dshHomeDir())
    const result = syncPresetTrees(bundledPresetsRoot(), target, [...BUNDLED_PRESET_IDS], rewritePresetFile)
    for (const { id, error } of result.failed) {
      host.logger.warn(`[dsh-chatgpt-subscription] agent preset "${id}" sync failed: ${error}`)
    }
    if (result.synced.length > 0) {
      host.logger.info(`[dsh-chatgpt-subscription] agent presets synced into ${target}: ${result.synced.join(', ')}`)
    }
  } catch (error) {
    // A read-only home or a locked directory must not fail plugin load:
    // the preset is a convenience, not a capability this plugin provides.
    host.logger.warn(`[dsh-chatgpt-subscription] agent preset sync skipped: ${String(error)}`)
  }
  return () => undefined
}
