import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DISPATCH_PRESET,
  DISPATCH_PRESET_ID,
  PRESET_REGISTRY_PACKAGE,
  WORKING_DIRECTORY_PACKAGE,
  installDispatchPreset,
  resolveDispatchPreset,
  type AgentPresetRegistry,
  type PresetDefinition,
  type PresetHost,
  type PresetInstall,
  type PresetRow,
} from '../../src/host/runtime/presets/agent-preset.ts'
import {
  bundledPresetsRoot,
  installBundledPresets,
  presetTargetRoot,
} from '../../src/host/runtime/presets/preset-sync.ts'
import { dshHomeDir } from '../../src/host/common/home.ts'

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
    expect(DISPATCH_PRESET.name?.trim().length).toBeGreaterThan(0)
    expect(DISPATCH_PRESET.order).toBe(5)
    expect(DISPATCH_PRESET.description?.trim().length).toBeGreaterThan(0)
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
      'code-mode',
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
      '@eddyskywalker/dsh-chatgpt-subscription/codemode',
      '@deepseek-ai/dsh-tool-present',
    ])
  })

  it('names the group rows and their nested rows as the bundle does', () => {
    expect(nestedIds('planning')).toEqual(['plan-mode', 'plan-mode-pipeline'])
    // The pruner row is this plugin's own fork, not the harness package: it
    // skips cache-prefix providers whole-session, so the rewrite that would
    // invalidate the provider's content-prefix cache never happens on them.
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

  it('mounts the plan-mode pipeline row inside the planMode realm, in both copies', () => {
    // The row calls ctx.planMode.set, so it must stay inside the `planning`
    // group: outside that realm it would resolve no planMode at all and quietly
    // register nothing. Its specifier is this plugin's own subpath export, so no
    // harness generation ships it — which is why the id/name pair, not the
    // package, is what the two copies must agree on.
    const specifier = '@eddyskywalker/dsh-chatgpt-subscription/plan-mode-pipeline'
    const declared = rowById('plan-mode-pipeline')
    expect(declared.id).toBe('plan-mode-pipeline')
    expect(declared.name).toBe(specifier)
    // No config block: the planModePipeline switch defaults to on.
    expect(declared.config).toBeUndefined()
    expect(nestedIds('planning')).toContain(declared.id)

    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    expect(yml).toContain(`    - id: plan-mode-pipeline\n      name: '${specifier}'`)
  })

  it('mounts the forked plan-mode and pruner rows, in both copies', () => {
    // Both rows are this plugin's own subpath exports, so no harness
    // generation ships them: the id/name pair is what the two copies must
    // agree on, and the preset sync disables a row whose export is absent.
    const planMode = '@eddyskywalker/dsh-chatgpt-subscription/plan-mode'
    const pruner = '@eddyskywalker/dsh-chatgpt-subscription/tool-result-pruner'
    expect(rowById('plan-mode').name).toBe(planMode)
    expect(rowById('tool-result-pruner').name).toBe(pruner)
    expect(rowById('tool-result-pruner').config).toEqual({
      thresholdChars: 8192,
      headChars: 4096,
      tailChars: 1024,
    })

    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    expect(yml).toContain(`    - id: plan-mode\n      name: '${planMode}'`)
    expect(yml).toContain(`    - id: tool-result-pruner\n      name: '${pruner}'`)
  })

  it('keeps every group row behind the isolate realms its rows need', () => {
    // The registry refuses a preset whose rows publish a service into the root
    // realm, so these realms are what makes the declaration mountable at all.
    expect(rowById('planning')).toMatchObject({ group: true, isolate: { planMode: true } })
    expect(rowById('compaction')).toMatchObject({ group: true })
    // `toolResultPruner` shares the realm because `compaction-basic` reads
    // the pruner through `ctx.get`; an instance outside the realm is
    // invisible to it.
    expect(rowById('compaction').isolate).toEqual({ compaction: true, toolResultPruner: true })
    expect(rowById('delegation')).toMatchObject({ group: true, isolate: { workflowEngine: true } })
  })

  it('keeps the rows the dispatch contract depends on', () => {
    // The route rules in the persona exist only because the delegation tools
    // expose a model choice; the PTC presentation is the mode this preset is for.
    // Released Harnesses through 0.2.1-rc.3 read `modelSelectionSettings`; later
    // generations read `modelSelection` + `modelDiscovery`. Keep both contracts.
    expect(rowById('tool-subagent').config).toMatchObject({
      modelSelectionSettings: true,
      modelSelection: true,
      modelDiscovery: true,
    })
    // Code Mode carries its own executor row and keeps only the minimal native
    // whitelist; every other registered tool stays reachable inside code_run.
    expect(rowById('code-mode')).toEqual({
      id: 'code-mode',
      name: '@eddyskywalker/dsh-chatgpt-subscription/codemode',
      config: {
        nativeToolsOnly: true,
        nativeTools: ['cache_warmup_result', 'dispatch_ledger', 'progress_update', 'structured_output'],
      },
    })
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    expect(yml).toContain("    nativeToolsOnly: true\n    nativeTools:\n      - cache_warmup_result\n      - dispatch_ledger\n      - progress_update\n      - structured_output")
    expect(yml).not.toContain('      - win_bash')
    const personaPrefix = (rowById('persona').config as { prefix: string }).prefix
    expect(personaPrefix).toContain('including shell tools')
    expect(personaPrefix).not.toContain('win_bash')
    expect(yml).not.toContain('win_bash')
    expect(rowById('tool-ask-user')).toEqual({
      id: 'tool-ask-user',
      name: '@deepseek-ai/dsh-tool-ask-user',
    })
    expect(rowById('persona').config).toMatchObject({ suffix: 'Your working directory is {{cwd}}.' })
    expect((rowById('persona').config as { prefix: string }).prefix).not.toContain('{{cwd}}')
  })

  it('strips persona.config.suffix on >=0.2.1 where @deepseek-ai/dsh-working-directory replaces {{cwd}}', async () => {
    expect(resolveDispatchPreset(specifier => specifier === '@deepseek-ai/dsh-tool-subagent-control/list-agents'
      || specifier === '@deepseek-ai/dsh-tool-executor-native')).toBe(DISPATCH_PRESET)
    const resolved021 = resolveDispatchPreset(specifier => specifier === WORKING_DIRECTORY_PACKAGE)
    const personaRow = resolved021.plugins.find(row => row.id === 'persona')
    expect(personaRow?.config).toBeDefined()
    expect('suffix' in (personaRow!.config as Record<string, unknown>)).toBe(false)
    expect(JSON.stringify(resolved021)).not.toContain('{{cwd}}')

    // Verify against the real 0.2.1 SystemPrompt service where only `provider` and
    // `model` variables are registered (no `cwd` variable).
    const SystemPromptModule = await import('@deepseek-ai/dsh-system-prompt')
    const SystemPrompt = SystemPromptModule.default ?? SystemPromptModule.SystemPrompt
    const { Context } = await import('@deepseek-ai/cordis')
    const ctx = new Context()
    try {
      try {
        const sessionProjectionPkg = '@deepseek-ai/dsh-session-projection'
        const projections = (await import(sessionProjectionPkg)) as {
          default?: unknown
          SessionProjections?: unknown
        }
        const SessionProjections = projections.default ?? projections.SessionProjections ?? projections
        if (SessionProjections) await (ctx.plugin as (plugin: unknown) => unknown)(SessionProjections)
      } catch {
        // Older harness generations without a standalone session-projection plugin.
      }
      const config = personaRow!.config as { prefix: string; suffix?: string }
      await ctx.plugin(SystemPrompt, {
        personaPrefix: config.prefix,
        personaSuffix: config.suffix ?? '',
      })
      ctx.systemPrompt.variable('provider', () => 'codex-chatgpt')
      let model = 'gpt-5.4'
      ctx.systemPrompt.variable('model', () => model)
      const rendered = SystemPromptModule.renderPrompt(await ctx.systemPrompt.assemble())
      expect(rendered).not.toContain('{{cwd}}')
      // The persona names no prompt variable: switching models must not rewrite
      // the head of the system prompt — and with it the content-prefix cache.
      expect(rendered).not.toContain('You are powered by')
      model = 'kimi-for-coding'
      const afterSwitch = SystemPromptModule.renderPrompt(await ctx.systemPrompt.assemble())
      expect(afterSwitch).toBe(rendered)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drops the standalone list-agents row only when its export is absent', () => {
    const legacyEntry = '@deepseek-ai/dsh-tool-subagent-control/list-agents'
    const legacy = resolveDispatchPreset(specifier => specifier === WORKING_DIRECTORY_PACKAGE || specifier === legacyEntry)
    expect(allRows(legacy.plugins).map(row => row.id)).toContain('tool-subagent-list-agents')

    const current = resolveDispatchPreset(specifier => specifier === WORKING_DIRECTORY_PACKAGE)
    const ids = allRows(current.plugins).map(row => row.id)
    expect(ids).not.toContain('tool-subagent-list-agents')
    expect(ids).toContain('tool-subagent-control')
    expect(ids).toContain('tool-subagent')
  })

  it('falls back from Code Mode to PTC on generations without the native executor', () => {
    // No native executor: the deprecated presentation row is what every
    // generation before Code Mode ran.
    const legacy = resolveDispatchPreset(() => false)
    expect(legacy.plugins.find(row => row.id === 'tool-presentation')).toMatchObject({
      name: '@deepseek-ai/dsh-agent-tool-presentation',
      config: { mode: 'ptc' },
    })
    expect(legacy.plugins.find(row => row.id === 'code-mode')).toBeUndefined()

    // Native executor absent but PTC executor present: that executor replaces
    // the deprecated row, exactly as before Code Mode existed.
    const ptc = resolveDispatchPreset(specifier => specifier === '@deepseek-ai/dsh-tool-executor-ptc')
    expect(ptc.plugins.find(row => row.id === 'tool-executor-ptc')).toEqual({
      id: 'tool-executor-ptc',
      name: '@deepseek-ai/dsh-tool-executor-ptc',
    })
    expect(ptc.plugins.find(row => row.id === 'tool-presentation')).toBeUndefined()
    expect(ptc.plugins.find(row => row.id === 'code-mode')).toBeUndefined()

    // Native executor present: the declaration is used as written, with no PTC
    // executor row mounted beside the Code Mode row.
    const codemode = resolveDispatchPreset(specifier => specifier === '@deepseek-ai/dsh-tool-executor-native')
    expect(codemode.plugins.find(row => row.id === 'code-mode')).toEqual({
      id: 'code-mode',
      name: '@eddyskywalker/dsh-chatgpt-subscription/codemode',
      config: {
        nativeToolsOnly: true,
        nativeTools: ['cache_warmup_result', 'dispatch_ledger', 'progress_update', 'structured_output'],
      },
    })
    expect(codemode.plugins.find(row => row.id === 'tool-executor-ptc')).toBeUndefined()
    expect(codemode.plugins.find(row => row.id === 'tool-presentation')).toBeUndefined()
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
  it('registers the definition unchanged when every legacy row is still available, and suffix-stripped otherwise', async () => {
    const pre021 = fakeRegistry()
    const pre021Host = fakeHost({ agentPresets: pre021.registry })

    // Code Mode requires the native executor, so the unchanged declaration is
    // only reachable when that package resolves as well.
    expect(installDispatchPreset(pre021Host.host, specifier => specifier === PRESET_REGISTRY_PACKAGE
      || specifier === '@deepseek-ai/dsh-tool-subagent-control/list-agents'
      || specifier === '@deepseek-ai/dsh-tool-executor-native')).toBe('registered')
    expect(pre021Host.effects).toHaveLength(1)
    expect(pre021.register).not.toHaveBeenCalled()

    const disposer = await pre021Host.effects[0]!()
    expect(pre021.register).toHaveBeenCalledTimes(1)
    expect(pre021.register.mock.calls[0]?.[0]).toBe(DISPATCH_PRESET)
    expect(disposer).toBe(pre021.unregister)
    expect(pre021Host.warnings).toEqual([])
    expect(pre021Host.infos.join('\n')).toContain('dispatch')

    const post021 = fakeRegistry()
    const post021Host = fakeHost({ agentPresets: post021.registry })
    expect(installDispatchPreset(post021Host.host, () => true)).toBe('registered')
    await post021Host.effects[0]!()
    expect(post021.register).toHaveBeenCalledTimes(1)
    expect(post021.register.mock.calls[0]?.[0]).toEqual(resolveDispatchPreset(() => true))
    expect(JSON.stringify(post021.register.mock.calls[0]?.[0])).not.toContain('{{cwd}}')
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

describe('the persona block the declaration transcribes', () => {
  /**
   * Dedent the YAML `prefix: |` block scalar of a preset row into the text the
   * runtime mounts. Four of the six rows of `agent.cordis.yml` are not pinned by
   * any assertion, so a rule edit that reaches only one of the two copies (the
   * YAML the legacy sync deploys, the declaration 0.1.7 registers) ships a
   * divergent preset with every test still green. This reads the shipped file
   * instead of a hand-copied fixture, so it cannot drift from it.
   */
  function personaBlockOf(yml: string): string {
    const lines = yml.split('\n')
    const start = lines.findIndex(line => line.trim() === 'prefix: |')
    if (start < 0) throw new Error('agent.cordis.yml carries no "prefix: |" block')
    const block: string[] = []
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === '') { block.push(''); continue }
      if (!line.startsWith('      ')) break
      block.push(line.slice(6))
    }
    return block.join('\n').replace(/\n+$/, '')
  }

  /** The `persona` row's inline prefix from the runtime declaration. */
  function declaredPrefix(): string {
    const found = allRows().find(row => row.id === 'persona')
    const config = found?.config as { prefix?: unknown } | undefined
    if (typeof config?.prefix !== 'string') throw new Error('the declaration carries no persona prefix')
    return config.prefix.replace(/\n+$/, '')
  }

  function blockOf(yml: string, marker: string, indent: number): string {
    const ymlLines = yml.split('\n')
    const start = ymlLines.findIndex(line => line.trim() === marker)
    if (start < 0) throw new Error(`agent.cordis.yml carries no "${marker}" block`)
    const block: string[] = []
    for (const line of ymlLines.slice(start + 1)) {
      if (line.trim() === '') { block.push(''); continue }
      if (!line.startsWith(' '.repeat(indent))) break
      block.push(line.slice(indent))
    }
    return block.join('\n').replace(/\n+$/, '')
  }

  function declaredPlanModeSection(): string {
    const found = allRows().find(row => row.id === 'plan-mode')
    const config = found?.config as { section?: unknown } | undefined
    if (typeof config?.section !== 'string') throw new Error('the declaration carries no plan-mode section')
    return config.section.replace(/\n+$/, '')
  }

  it('keeps persona and plan-mode sections byte-identical between YAML and declaration', () => {
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    const prefix = declaredPrefix()
    const section = declaredPlanModeSection()
    expect(prefix.length).toBeGreaterThan(1000)
    expect(prefix.length).toBeLessThan(15500)
    expect(prefix).toBe(personaBlockOf(yml))
    expect(section).toBe(blockOf(yml, 'section: |', 14))
  })

  it('keeps prompt cache invariants and stays vendor-agnostic', () => {
    const prefix = declaredPrefix()
    const section = declaredPlanModeSection()
    for (const text of [prefix, section]) {
      expect(text).not.toContain('{{model}}')
      expect(text).not.toContain('{{cwd}}')
      expect(text).not.toContain('You are powered by')
      expect(text).not.toMatch(/k3\.1-pro|kimi-code|Kimi Code|gpt-5|claude-opus|deepseek-v/i)
    }
  })

  it('references required dispatch tools and execution topologies', () => {
    const prefix = declaredPrefix()
    const section = declaredPlanModeSection()
    for (const token of ['code_run', 'list_subagent_models', 'enter_plan_mode', 'leave_plan_mode', 'exit_plan_mode', 'hand_back']) {
      expect(prefix).toContain(token)
    }
    for (const topology of ['Lead-Core', 'Hybrid', 'Fan-out']) {
      expect(prefix).toContain(topology)
      expect(section).toContain(topology)
    }
    expect(prefix).not.toContain('subagentModelAuthorization')
  })

  it('ships both released and current model-selection switches in agent.cordis.yml', () => {
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    expect(/^ {8}modelSelectionSettings: true$/mu.test(yml)).toBe(true)
    expect(/^ {8}modelSelection: true$/mu.test(yml)).toBe(true)
    expect(/^ {8}modelDiscovery: true$/mu.test(yml)).toBe(true)
  })
})

describe('the bundled files the declaration transcribes', () => {
  it('still ships the preset the declaration stands in for', () => {
    expect(existsSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'preset.yml'))).toBe(true)
  })
})

