import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUNDLED_PRESET_IDS,
  bundledPresetsRoot,
  packageInstalled,
  presetTargetRoot,
  reconcilePackageNames,
  reconcilePreset,
  resolvesFromHere,
  rewritePresetFile,
  syncPresetTrees,
} from '../src/host/preset-sync.ts'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preset-sync-'))
  roots.push(dir)
  return dir
}

/** Lay out a source preset tree and return its root. */
function sourceTree(files: Record<string, string>): string {
  const root = tempDir()
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('bundled preset location', () => {
  it('ships the dispatch preset with its metadata beside the composition', () => {
    const root = bundledPresetsRoot()
    expect(existsSync(join(root, 'dispatch', 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(root, 'dispatch', 'preset.yml'))).toBe(true)
    expect(BUNDLED_PRESET_IDS).toContain('dispatch')
  })

  it('derives the target root from the harness home', () => {
    expect(presetTargetRoot('/home/u/.dsh')).toBe(join('/home/u/.dsh', '.agent-presets'))
  })
})

describe('syncPresetTrees', () => {
  it('copies a bundled preset into the discovery root', () => {
    const source = sourceTree({ 'alpha/agent.cordis.yml': 'name: x\n', 'alpha/preset.yml': 'name: A\n' })
    const target = join(tempDir(), '.agent-presets')

    const first = syncPresetTrees(source, target)
    expect(first.synced).toEqual(['alpha'])
    expect(first.failed).toEqual([])
    expect(readFileSync(join(target, 'alpha', 'agent.cordis.yml'), 'utf8')).toBe('name: x\n')

    // A second run is a no-op: the tree is already byte-identical.
    const second = syncPresetTrees(source, target)
    expect(second.synced).toEqual([])
    expect(second.current).toEqual(['alpha'])
  })

  it('rewrites on a content change and prunes files the source dropped', () => {
    const source = sourceTree({ 'alpha/agent.cordis.yml': 'v1\n', 'alpha/extra.txt': 'gone\n' })
    const target = join(tempDir(), '.agent-presets')
    syncPresetTrees(source, target)

    rmSync(join(source, 'alpha', 'extra.txt'))
    writeFileSync(join(source, 'alpha', 'agent.cordis.yml'), 'v2\n')
    const result = syncPresetTrees(source, target)

    expect(result.synced).toEqual(['alpha'])
    expect(readFileSync(join(target, 'alpha', 'agent.cordis.yml'), 'utf8')).toBe('v2\n')
    expect(existsSync(join(target, 'alpha', 'extra.txt'))).toBe(false)
  })

  it('never touches preset directories the plugin does not own', () => {
    const source = sourceTree({ 'alpha/agent.cordis.yml': 'name: x\n' })
    const target = join(tempDir(), '.agent-presets')
    mkdirSync(join(target, 'user-authored'), { recursive: true })
    writeFileSync(join(target, 'user-authored', 'agent.cordis.yml'), 'mine\n')

    syncPresetTrees(source, target)

    expect(readFileSync(join(target, 'user-authored', 'agent.cordis.yml'), 'utf8')).toBe('mine\n')
  })

  it('retires a previously bundled id and leaves other directories alone', () => {
    const source = sourceTree({ 'alpha/agent.cordis.yml': 'name: x\n' })
    const target = join(tempDir(), '.agent-presets')
    mkdirSync(join(target, 'old'), { recursive: true })
    writeFileSync(join(target, 'old', 'agent.cordis.yml'), 'stale\n')
    mkdirSync(join(target, 'keepme'), { recursive: true })
    writeFileSync(join(target, 'keepme', 'agent.cordis.yml'), 'mine\n')

    const result = syncPresetTrees(source, target, ['old'])

    expect(result.retired).toEqual(['old'])
    expect(existsSync(join(target, 'old'))).toBe(false)
    expect(existsSync(join(target, 'keepme'))).toBe(true)
  })

  it('keeps shipping a bundled id instead of retiring it', () => {
    const source = sourceTree({ 'alpha/agent.cordis.yml': 'name: x\n' })
    const target = join(tempDir(), '.agent-presets')
    const result = syncPresetTrees(source, target, ['alpha'])
    expect(result.retired).toEqual([])
    expect(existsSync(join(target, 'alpha', 'agent.cordis.yml'))).toBe(true)
  })

  it('reports a missing source root without creating anything', () => {
    const target = join(tempDir(), '.agent-presets')
    const result = syncPresetTrees(join(tempDir(), 'absent'), target)
    expect(result).toEqual({ synced: [], current: [], failed: [], retired: [] })
    expect(existsSync(target)).toBe(false)
  })

  it('writes rewritten text, converges, and rewrites back when the installation changes', () => {
    const source = sourceTree({ 'alpha/agent.cordis.yml': 'row: bundled\n', 'alpha/preset.yml': 'name: A\n' })
    const target = join(tempDir(), '.agent-presets')
    const rename = (_rel: string, content: string): string => content.replace('bundled', 'current')

    expect(syncPresetTrees(source, target, [], rename).synced).toEqual(['alpha'])
    expect(readFileSync(join(target, 'alpha', 'agent.cordis.yml'), 'utf8')).toBe('row: current\n')

    // The rewritten target is what the next run expects, so it is not a difference.
    expect(syncPresetTrees(source, target, [], rename)).toMatchObject({ synced: [], current: ['alpha'] })

    // An installation that no longer applies the rewrite brings the target back.
    expect(syncPresetTrees(source, target, [], (_rel, content) => content).synced).toEqual(['alpha'])
    expect(readFileSync(join(target, 'alpha', 'agent.cordis.yml'), 'utf8')).toBe('row: bundled\n')
  })

  it('offers only the extensions a package name can appear in', () => {
    const source = sourceTree({ 'alpha/notes.txt': 'bundled\n', 'alpha/agent.cordis.yml': 'bundled\n' })
    const target = join(tempDir(), '.agent-presets')
    const seen: string[] = []
    syncPresetTrees(source, target, [], (rel, content) => {
      seen.push(rel)
      return content
    })
    expect(seen).toEqual(['agent.cordis.yml'])
  })
})

describe('package name reconciliation', () => {
  /** The row the dispatch preset carries, naming the package as it was up to harness 0.1.5. */
  const BUNDLED_ROW = "      name: '@deepseek-ai/dsh-workflow-worker-thread'\n"
  const RENAMED = '@deepseek-ai/dsh-workflow-worker-thread'
  const CURRENT = '@deepseek-ai/dsh-workflow-ptc'

  it('keeps the bundled spelling while the installation still ships it', () => {
    expect(reconcilePackageNames(BUNDLED_ROW, name => name === RENAMED)).toBe(BUNDLED_ROW)
  })

  it('rewrites to the spelling a renamed installation ships', () => {
    expect(reconcilePackageNames(BUNDLED_ROW, name => name === CURRENT))
      .toBe("      name: '@deepseek-ai/dsh-workflow-ptc'\n")
  })

  it('rewrites the newer spelling back to the pre-0.1.6 name on an older installation', () => {
    const modernRow = "      name: '@deepseek-ai/dsh-workflow-ptc'\n"
    expect(reconcilePackageNames(modernRow, name => name === RENAMED))
      .toBe(BUNDLED_ROW)
  })

  it('keeps the bundled spelling when neither spelling resolves', () => {
    expect(reconcilePackageNames(BUNDLED_ROW, () => false)).toBe(BUNDLED_ROW)
  })

  it('leaves text naming no renamed package alone', () => {
    expect(reconcilePackageNames('name: A\n', () => false)).toBe('name: A\n')
  })

  it('leaves text with no renamed package alone on the default rewrite', () => {
    expect(rewritePresetFile('dispatch/agent.cordis.yml', 'name: A\n')).toBe('name: A\n')
  })

  it('reports an uninstalled specifier as unresolvable', () => {
    expect(resolvesFromHere('@deepseek-ai/dsh-not-a-published-package')).toBe(false)
  })

  it('detects packages installed across candidate root node_modules', () => {
    const root = tempDir()
    const pkgDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-sample-pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), '{}')

    expect(packageInstalled('@deepseek-ai/dsh-sample-pkg', [root])).toBe(true)
    expect(packageInstalled('@deepseek-ai/dsh-missing-pkg', [root])).toBe(false)
  })

  it('ships the row the harness renamed, under its pre-0.1.6 name', () => {
    const bundled = readFileSync(join(bundledPresetsRoot(), 'dispatch', 'agent.cordis.yml'), 'utf8')
    expect(bundled).toContain(`name: '${RENAMED}'`)
  })
})

describe('rows the installation cannot mount', () => {
  /** The row whose package the oldest supported harness does not ship at all. */
  const PRESENT = '@deepseek-ai/dsh-tool-present'
  const PRESENT_ROW = `- id: present\n  name: '${PRESENT}'\n`

  it('disables a row whose package this installation does not ship', () => {
    expect(reconcilePreset(PRESENT_ROW, () => false)).toBe(`${PRESENT_ROW}  disabled: true\n`)
  })

  it('leaves the row enabled when this installation ships the package', () => {
    expect(reconcilePreset(PRESENT_ROW, name => name === PRESENT)).toBe(PRESENT_ROW)
  })

  it('disables the row at its own indentation', () => {
    const nested = `  - id: present\n    name: '${PRESENT}'\n`
    expect(reconcilePreset(nested, () => false)).toBe(`${nested}    disabled: true\n`)
  })

  it('leaves a row that already declares disabled alone', () => {
    const disabled = `${PRESENT_ROW}  disabled: true\n`
    expect(reconcilePreset(disabled, () => false)).toBe(disabled)
  })

  it('keeps a nested config block under the row it disables', () => {
    const withConfig = `- id: present\n  name: '${PRESENT}'\n  config:\n    mode: ptc\n`
    expect(reconcilePreset(withConfig, () => false))
      .toBe(`- id: present\n  name: '${PRESENT}'\n  disabled: true\n  config:\n    mode: ptc\n`)
  })

  it('leaves a row outside the optional set alone', () => {
    const other = "- id: other\n  name: '@deepseek-ai/dsh-not-installed'\n"
    expect(reconcilePreset(other, () => false)).toBe(other)
  })

  it('deploys the row disabled and converges on the next run', () => {
    const source = sourceTree({ 'alpha/agent.cordis.yml': PRESENT_ROW })
    const target = join(tempDir(), '.agent-presets')
    const rewrite = (_rel: string, content: string): string => reconcilePreset(content, () => false)

    expect(syncPresetTrees(source, target, [], rewrite).synced).toEqual(['alpha'])
    expect(readFileSync(join(target, 'alpha', 'agent.cordis.yml'), 'utf8'))
      .toBe(`${PRESENT_ROW}  disabled: true\n`)

    // The rewritten target is what the next run expects, so it is not a difference.
    expect(syncPresetTrees(source, target, [], rewrite)).toMatchObject({ synced: [], current: ['alpha'] })
  })

  it('ships the row enabled in the bundle, for the sync to disable where it must', () => {
    const bundled = readFileSync(join(bundledPresetsRoot(), 'dispatch', 'agent.cordis.yml'), 'utf8')
    expect(bundled).toContain(`- id: present\n  name: '${PRESENT}'`)
  })
})

describe('the bundled composition against the package sets harness generations ship', () => {
  const PRESENT = '@deepseek-ai/dsh-tool-present'
  const WORKFLOW_BEFORE_RENAME = '@deepseek-ai/dsh-workflow-worker-thread'

  /** Package sets a supported harness generation presents, by what it does not ship. */
  const GENERATIONS: readonly { label: string; lacks: readonly string[] }[] = [
    { label: 'one shipping every referenced package', lacks: [] },
    { label: '0.1.6, which renamed the workflow engine', lacks: [WORKFLOW_BEFORE_RENAME] },
    { label: 'one older than the `present` tool', lacks: [PRESENT] },
    { label: 'one missing both', lacks: [WORKFLOW_BEFORE_RENAME, PRESENT] },
  ]

  /** Indentation of one line. */
  const indentation = (line: string): number => line.length - line.trimStart().length

  /**
   * Whether the loader would start the row whose `name:` key sits at `index`:
   * the roster's own rule, which skips exactly the rows declaring `disabled`.
   */
  function rowStarts(lines: readonly string[], index: number): boolean {
    const indent = indentation(lines[index] ?? '')
    for (const line of lines.slice(index + 1)) {
      const text = line.trim()
      if (text === '' || text.startsWith('#')) continue
      const own = indentation(line)
      if (own < indent) break
      if (own === indent && text.startsWith('disabled:')) return false
    }
    return true
  }

  /** Every row the roster would refuse to mount, by its own rule. */
  function unmountableRows(content: string, ships: (name: string) => boolean): string[] {
    const lines = content.split('\n')
    const found: string[] = []
    for (const [index, line] of lines.entries()) {
      const name = /^\s*name:\s*'(@deepseek-ai\/[^']+)'\s*$/.exec(line)?.[1]
      if (name === undefined || !rowStarts(lines, index) || ships(name)) continue
      found.push(name)
    }
    return found
  }

  const bundled = readFileSync(join(bundledPresetsRoot(), 'dispatch', 'agent.cordis.yml'), 'utf8')

  for (const generation of GENERATIONS) {
    const ships = (name: string): boolean => !generation.lacks.includes(name)
    it(`leaves no row unresolvable on a harness ${generation.label}`, () => {
      expect(unmountableRows(reconcilePreset(bundled, ships), ships)).toEqual([])
    })
  }

  it('disables the `present` row only where the package is absent', () => {
    const withoutPresent = reconcilePreset(bundled, name => name !== PRESENT)
    expect(withoutPresent).toContain(`- id: present\n  name: '${PRESENT}'\n  disabled: true\n`)

    const withPresent = reconcilePreset(bundled, () => true)
    expect(withPresent).toContain(`- id: present\n  name: '${PRESENT}'\n`)
    expect(withPresent).not.toContain(`- id: present\n  name: '${PRESENT}'\n  disabled: true`)
  })
})
