import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISPATCH_PRESET,
  DISPATCH_PRESET_ID,
  PRESET_REGISTRY_PACKAGE,
  installDispatchPreset,
  type AgentPresetRegistry,
  type PresetDefinition,
  type PresetHost,
  type PresetInstall,
  type PresetRow,
} from '../src/host/agent-preset.ts'
import {
  bundledPresetsRoot,
  installBundledPresets,
  presetTargetRoot,
} from '../src/host/preset-sync.ts'
import { dshHomeDir } from '../src/host/common/home.ts'

/** Every row of the definition, a group's nested rows included, in mount order. */
function allRows(rows: readonly PresetRow[] = DISPATCH_PRESET.plugins): PresetRow[] {
  return rows.flatMap(row => [row, ...(Array.isArray(row.config) ? allRows(row.config as PresetRow[]) : [])])
}

/** One row by id, or a failure naming the id. */
function rowById(id: string): PresetRow {
  const found = allRows().find(row => row.id === id)
  if (found === undefined) throw new Error(`the definition has no row "${id}"`)
  return found
}

/** The nested row ids of one group row. */
function nestedIds(id: string): string[] {
  const config = rowById(id).config
  if (!Array.isArray(config)) throw new Error(`row "${id}" is not a group`)
  return (config as PresetRow[]).map(row => row.id)
}

/** A host whose logger and effect seam the test reads back. */
interface FakeHost {
  host: PresetHost
  /** Effect bodies the plugin registered, in order. */
  effects: (() => Promise<() => Promise<void>>)[]
  warnings: string[]
  infos: string[]
}

function fakeHost(options: { agentPresets?: unknown; getThrows?: boolean } = {}): FakeHost {
  const effects: FakeHost['effects'] = []
  const warnings: string[] = []
  const infos: string[] = []
  const host: PresetHost = {
    get: (name) => {
      if (options.getThrows === true) throw new Error('the service lookup is broken')
      return name === 'agentPresets' ? options.agentPresets : undefined
    },
    effect: (execute) => {
      effects.push(execute)
      return () => undefined
    },
    logger: {
      info: message => { infos.push(message) },
      warn: message => { warnings.push(message) },
    },
  }
  return { host, effects, warnings, infos }
}

/** A registry that records the definition and reports its own unregisterer. */
function fakeRegistry() {
  const unregister = vi.fn(async () => undefined)
  const register = vi.fn<(definition: PresetDefinition) => Promise<() => Promise<void>>>(async () => unregister)
  const registry: AgentPresetRegistry = { register }
  return { registry, register, unregister }
}

/** The directory the legacy file copy writes the bundled preset into. */
function copiedPresetDir(): string {
  return join(presetTargetRoot(dshHomeDir()), DISPATCH_PRESET_ID)
}

const tempDirs: string[] = []

afterEach(() => {
  rmSync(presetTargetRoot(dshHomeDir()), { recursive: true, force: true })
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the dispatch definition', () => {
  it('carries the identity the bundled preset.yml declares', () => {
    expect(DISPATCH_PRESET.id).toBe('dispatch')
    expect(DISPATCH_PRESET_ID).toBe(DISPATCH_PRESET.id)
    expect(DISPATCH_PRESET.name).toBe('调度模式')
    expect(DISPATCH_PRESET.order).toBe(5)
    expect(DISPATCH_PRESET.description).toBe(
      '基于 PTC 模式的调度 Agent：先分诊任务复杂度，L2 任务在规划前先做澄清访谈，再由主代理规划、派发子代理（显式选择子代理模型）、审查与验收。',
    )
  })

  it('keeps the nineteen rows of agent.cordis.yml, in order', () => {
    expect(DISPATCH_PRESET.plugins.map(row => row.id)).toEqual([
      'persona',
      'agent-instructions',
      'tool-bash',
      'tool-pwsh',
      'tool-fs',
      'tool-fs-search',
      'tool-jobs',
      'skill-filesystem',
      'tool-skill',
      'command-goal',
      'tool-goal',
      'planning',
      'compaction',
      'delegation',
      'tool-ask-user',
      'tool-todo',
      'tool-web',
      'tool-presentation',
      'present',
    ])
  })

  it('mounts the package name each row carries', () => {
    expect(DISPATCH_PRESET.plugins.map(row => row.name)).toEqual([
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-agent-instructions',
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-pwsh',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search',
      '@deepseek-ai/dsh-tool-jobs',
      '@deepseek-ai/dsh-skill-filesystem',
      '@deepseek-ai/dsh-tool-skill',
      '@deepseek-ai/dsh-command-goal',
      '@deepseek-ai/dsh-tool-goal',
      'cordis:group',
      'cordis:group',
      'cordis:group',
      '@deepseek-ai/dsh-tool-ask-user',
      '@deepseek-ai/dsh-tool-todo',
      '@deepseek-ai/dsh-tool-web',
      '@deepseek-ai/dsh-agent-tool-presentation',
      '@deepseek-ai/dsh-tool-present',
    ])
  })

  it('names the group rows and their nested rows as the bundle does', () => {
    expect(nestedIds('planning')).toEqual(['plan-mode'])
    expect(nestedIds('compaction')).toEqual(['compaction-basic', 'command-compact', 'tool-result-pruner'])
    expect(nestedIds('delegation')).toEqual([
      'tool-subagent-control',
      'tool-subagent-list-agents',
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-codex',
      'tool-subagent-claude-code',
      'workflow-worker-thread',
      'tool-workflow',
      'tool-ralph',
    ])
  })

  it('keeps every group row behind the isolate realms its rows need', () => {
    // The registry refuses a preset whose rows publish a service into the root
    // realm, so these realms are what makes the declaration mountable at all.
    expect(rowById('planning')).toMatchObject({ group: true, isolate: { planMode: true } })
    expect(rowById('compaction')).toMatchObject({
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
    })
    expect(rowById('delegation')).toMatchObject({ group: true, isolate: { workflowEngine: true } })
  })

  it('keeps the rows the dispatch contract depends on', () => {
    // The route rules in the persona exist only because the delegation tools
    // expose a model choice; the PTC presentation is the mode this preset is for.
    expect(rowById('tool-subagent').config).toMatchObject({ modelSelectionSettings: true })
    expect(rowById('tool-presentation').config).toEqual({ mode: 'ptc' })
    expect(rowById('persona').config).toMatchObject({ suffix: 'Your working directory is {{cwd}}.' })
  })

  it('mounts the harness 0.1.7 spelling of the renamed workflow package', () => {
    expect(rowById('workflow-worker-thread').name).toBe('@deepseek-ai/dsh-workflow-ptc')
    expect(allRows().map(row => row.name)).not.toContain('@deepseek-ai/dsh-workflow-worker-thread')
  })

  it('disables the shell tool of the platform this harness does not run on', () => {
    expect(rowById('tool-bash').disabled).toBe(process.platform === 'win32')
    expect(rowById('tool-pwsh').disabled).toBe(process.platform !== 'win32')
  })

  it('carries real booleans where the YAML carried a javascript expression', () => {
    for (const row of allRows()) {
      if ('disabled' in row) expect(typeof row.disabled).toBe('boolean')
    }
    // Nothing evaluates a declaration, so an expression surviving as text would
    // reach the registry as a truthy string and disable the row on every platform.
    expect(JSON.stringify(DISPATCH_PRESET)).not.toContain('process.platform')
    expect(JSON.stringify(DISPATCH_PRESET)).not.toContain('__jsExpr')
  })

  it('keeps the rows the bundle ships disabled disabled, and no others', () => {
    const disabled = allRows().filter(row => row.disabled === true).map(row => row.id)
    expect(disabled).toEqual([
      process.platform === 'win32' ? 'tool-bash' : 'tool-pwsh',
      'tool-subagent-codex',
      'tool-subagent-claude-code',
      'tool-workflow',
    ])
  })
})

describe('declaring the preset to the running harness', () => {
  it('registers exactly the definition when the mechanism is present', async () => {
    const { registry, register, unregister } = fakeRegistry()
    const { host, effects, warnings, infos } = fakeHost({ agentPresets: registry })

    expect(installDispatchPreset(host, () => true)).toBe('registered')
    expect(effects).toHaveLength(1)
    expect(register).not.toHaveBeenCalled()

    const disposer = await effects[0]!()
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[0]).toBe(DISPATCH_PRESET)
    expect(disposer).toBe(unregister)
    expect(warnings).toEqual([])
    expect(infos.join('\n')).toContain('dispatch')
  })

  it('retires the declaration through the harness unregisterer when the plugin unloads', async () => {
    const { registry, unregister } = fakeRegistry()
    const { host, effects } = fakeHost({ agentPresets: registry })

    installDispatchPreset(host, () => true)
    const disposer = await effects[0]!()
    expect(unregister).not.toHaveBeenCalled()

    await disposer()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it('never registers and reports the legacy mechanism when the row package does not resolve', () => {
    const { registry, register } = fakeRegistry()
    const { host, effects } = fakeHost({ agentPresets: registry })

    expect(installDispatchPreset(host, () => false)).toBe('legacy')
    expect(effects).toEqual([])
    expect(register).not.toHaveBeenCalled()
  })

  it('never registers and reports the legacy mechanism without the agentPresets service', () => {
    const { host, effects, warnings } = fakeHost()

    expect(installDispatchPreset(host, () => true)).toBe('legacy')
    expect(effects).toEqual([])
    // The package is there and the service is not: that combination is worth a
    // diagnostic, because it is how a late-provided registry would look.
    expect(warnings.join('\n')).toContain('no agentPresets service')
  })

  it('never registers against a service that cannot register definitions', () => {
    const { host, effects } = fakeHost({ agentPresets: { something: 'else' } })

    expect(installDispatchPreset(host, () => true)).toBe('legacy')
    expect(effects).toEqual([])
  })

  it('falls back to the legacy mechanism when the service lookup itself throws', () => {
    const { host, effects, warnings } = fakeHost({ getThrows: true })

    expect(installDispatchPreset(host, () => true)).toBe('legacy')
    expect(effects).toEqual([])
    expect(warnings.join('\n')).toContain('could not be registered')
  })

  it('never lets a rejected registration escape the effect it owns', async () => {
    const register = vi.fn<(definition: PresetDefinition) => Promise<() => Promise<void>>>(async () => {
      throw new Error('row 3 names no plugin')
    })
    const { host, effects, warnings } = fakeHost({ agentPresets: { register } as AgentPresetRegistry })

    expect(installDispatchPreset(host, () => true)).toBe('registered')

    // The effect body must settle on a disposer instead of rejecting: a plugin
    // entry whose body throws has no fiber, which fails the whole boot.
    const disposer = await effects[0]!()
    expect(typeof disposer).toBe('function')
    await expect(disposer()).resolves.toBeUndefined()
    expect(warnings.join('\n')).toContain('was not mounted')
    expect(warnings.join('\n')).toContain('row 3 names no plugin')
  })

  it('probes the package the harness 0.1.7 row ships', () => {
    expect(PRESET_REGISTRY_PACKAGE).toBe('@deepseek-ai/dsh-agent-preset')
  })
})

describe('the effect body both mechanisms are wired through', () => {
  /** The call src/index.ts makes. */
  function wire(host: PresetHost, resolves: (specifier: string) => boolean): () => void {
    return installBundledPresets(host, installDispatchPreset(host, resolves))
  }

  it('copies the bundled tree and registers nothing on a generation without the mechanism', () => {
    const { host, effects, warnings } = fakeHost()

    const disposer = wire(host, () => false)
    expect(typeof disposer).toBe('function')
    expect(effects).toEqual([])
    expect(warnings).toEqual([])

    expect(existsSync(join(copiedPresetDir(), 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(copiedPresetDir(), 'preset.yml'))).toBe(true)
    // The copy is the reconciled bundle: the row this installation cannot mount
    // is deployed disabled, exactly as the legacy path always deployed it.
    expect(readFileSync(join(copiedPresetDir(), 'agent.cordis.yml'), 'utf8'))
      .toContain("- id: present\n  name: '@deepseek-ai/dsh-tool-present'\n  disabled: true\n")
  })

  it('registers and writes nothing into the discovery root on 0.1.7 and later', async () => {
    const { registry, register, unregister } = fakeRegistry()
    const { host, effects, warnings, infos } = fakeHost({ agentPresets: registry })

    const disposer = wire(host, () => true)
    expect(existsSync(presetTargetRoot(dshHomeDir()))).toBe(false)
    expect(warnings).toEqual([])
    expect(infos).toEqual([])

    const registered = await effects[0]!()
    expect(register).toHaveBeenCalledTimes(1)
    expect(await registered).toBe(unregister)
    expect(disposer).toBeTypeOf('function')
  })

  it('reports nothing when the copied tree is already current', () => {
    wire(fakeHost().host, () => false)
    const { host, warnings, infos } = fakeHost()
    wire(host, () => false)
    expect(warnings).toEqual([])
    expect(infos).toEqual([])
  })

  it('never lets a failing copy escape plugin load', () => {
    // A home that cannot hold a directory — a file where the root belongs — is
    // the read-only-home failure the sync must survive.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-preset-host-'))
    tempDirs.push(dir)
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, '')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = blocker
    try {
      const { host, warnings } = fakeHost()
      expect(() => wire(host, () => false)).not.toThrow()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('agent preset sync skipped')
    } finally {
      process.env.DSH_HOME = previous
    }
  })

  it('accepts the real plugin context as its host', () => {
    // Compile-time contract for the one line src/index.ts calls this with.
    const install: (ctx: Context) => void = ctx => { wire(ctx, () => false) }
    expect(typeof install).toBe('function')
  })

  it('hands back the disposer shape ctx.effect accepts', () => {
    const install: PresetInstall = installDispatchPreset(fakeHost().host, () => false)
    expect(install).toBe('legacy')
    expect(typeof installBundledPresets(fakeHost().host, install)).toBe('function')
  })
})

describe('the bundled files the declaration transcribes', () => {
  it('still ships the preset the declaration stands in for', () => {
    expect(existsSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'preset.yml'))).toBe(true)
  })
})
