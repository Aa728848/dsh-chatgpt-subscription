import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUNDLED_PRESET_IDS,
  bundledPresetsRoot,
  presetTargetRoot,
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
})
