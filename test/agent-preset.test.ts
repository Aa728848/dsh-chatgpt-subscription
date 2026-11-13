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
      '基于 Code Mode 的调度 Agent：按决策状态分诊，明确工程任务快速执行，治理任务先访谈与审批；由主代理选择拓扑、显式路由子代理并统一验收。',
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

  it('keeps the YAML and the declaration byte-identical, and non-empty', () => {
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    const fromYaml = personaBlockOf(yml)
    expect(fromYaml.length).toBeGreaterThan(1000)
    expect(fromYaml).toBe(declaredPrefix())
  })

  it('keeps simple image generation in the current agent', () => {
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('[Media generation] Generate/revise/retry images directly')
      expect(persona).toContain('delegate complex creative work, never a bare call')
    }
  })

  it('keeps a route out of the inherit tool in both copies', () => {
    // 现场反馈：人格写着「每次派发都传 provider 与 model」，模型照做传给了
    // subagent_fork，守卫只能拒；四轮尝试全落空。两份副本都必须点名那个不接受
    // 路由字段的工具，以及要选路由时该用哪个。
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('Before every dispatch through an explicit-route tool (subagent)')
      expect(persona).toContain('Never pass provider/model to subagent_fork')
      expect(persona).toContain('Never pass provider/model to it')
    }
  })

  it('names no prompt variable, so a model switch cannot rewrite the prefix', () => {
    // `{{model}}` resolves from the agent's route at assembly time. Rendered
    // into the persona it makes the head of the system prompt depend on the
    // route, so a mid-session model switch rewrites it — and the harness
    // replaces the oldest system message in place, killing the cached prefix.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).not.toContain('{{model}}')
      expect(persona).not.toContain('You are powered by')
    }
  })

  it('scopes the fallback to one task and restores delegation on the next', () => {
    // The regression the field report is about: an agent that fell back once
    // kept refusing to delegate on every later task. Both copies must say that
    // fallback is task-scoped, that it is entered only after evidence, and that
    // the next task re-runs the triage regardless of it.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    const committed = [personaBlockOf(yml), declaredPrefix()]
    for (const persona of committed) {
      expect(persona).toContain('## R8 · Fallback')
      expect(persona).toContain('Fallback is a task-scoped, non-session-wide exception')
      expect(persona).toContain('covers only the single task that triggered it')
      expect(persona).toContain('When the next task begins, always return to R0 to triage anew')
      expect(persona).toContain('the same task brief has still not passed review after its third run under R6')
      // An empty/unlisted allowlist no longer qualifies: delegation works there,
      // it is only unrestricted, so it cannot be a fallback excuse (R2 state).
      expect(persona).toContain('An unmounted tool is the only routing condition that permits fallback')
      // The anti-patterns that made the stale fallback self-reinforcing.
      expect(persona).toContain('carrying a one-off R8 fallback into subsequent tasks')
      expect(persona).toContain('using a fixable tool rejection as a fallback excuse')
      // The condition-fix guidance for the two hard rejections seen in the field.
      expect(persona).toContain('active child limit')
      expect(persona).toContain('subagent model selection')
      // The old unbounded wording, which let the model declare an open-ended
      // session-wide fallback, must be gone from both copies.
      expect(persona).not.toContain('子代理连续失败')
      expect(persona).not.toContain('只有这些情况你才亲自执行')
    }
  })

  it('carries no legacy-runtime gate, and keeps the board as bookkeeping', () => {
    // The gate is gone: harness 0.2.1-rc.2 removed the legacy Agent Teams runtime
    // outright (spawn_teammate plus the team-scoped send_message / list_agents /
    // interrupt_agent), so "can this session orchestrate?" stopped being a
    // generation question. What survives is the part that was never about
    // generations - the shared task board is bookkeeping, never a dispatcher.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      // No generation probe survives, and triage is the first pipeline step.
      expect(persona).not.toContain('R0.5')
      expect(persona).not.toContain('Criterion: whether spawn_teammate exists')
      expect(persona).not.toContain('Never gate on wait_agent, send_message, list_agents, or interrupt_agent')
      expect(persona).not.toContain('A legacy Agent Teams runtime (pre-#7519)')
      expect(persona).not.toContain('Orchestration ready: subagent')
      expect(persona).not.toContain('is **not orchestratable**')
      expect(persona).not.toContain('Call ask_user_question once (see R-W) offering')
      expect(persona).toContain('[Execution Pipeline] R0 Triage -> [L2-Governed only: R-G Interview')
      // The board contract survives, because it was never about generations.
      expect(persona).toContain('[Agent Teams Board]')
      expect(persona).toContain('team_task_create and its list/get/update siblings')
      expect(persona).toContain('bookkeeping, not a second dispatcher')
      // The frozen PTC declaration keeps the board tools visible when it is off,
      // so presence is not availability and nothing may key on it.
      expect(persona).toContain('frozen declaration, not availability')
      expect(persona).toContain('confirm with team_task_list before relying on it')
      expect(persona).toContain('the dispatch ledger stays the dispatch authority and R5 briefs stay the task contract')
      expect(persona).toContain('never start work because a task is ready')
      expect(persona).toContain('never reassign a task to skip R6')
      // The anti-patterns that let a degraded branch back in.
      expect(persona).toContain('using teammate vocabulary / the team task board to replace R1–R6/R-W')
      // No trace of the stale premise survives in either copy.
      expect(persona).not.toContain('Dispatch Mode is **incompatible** with Agent Teams')
      expect(persona).not.toContain('whether spawn_teammate and wait_agent exist')
      expect(persona).not.toContain('## R-T')
      expect(persona).not.toContain('spawn_teammate 没有 provider/model')
      expect(persona).not.toContain('不要把子代理 session id 交给 send_message')
      expect(persona).not.toContain('说明你是子代理或 teammate')
    }
  })

  it('stops on the turn boundary instead of manufacturing a wait', () => {
    // Three field reports, one rule. The main agent used to (1) burn a long
    // command to wait for a subagent that was going to announce itself, (2) arm
    // a goal at task start, whose automatic continuation woke it in the middle
    // of that wait, and (3) end on a paragraph of prose where a question
    // belonged. Both copies must carry the whole boundary rule, and the
    // coordinator-only list must exclude it from subagents too.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('## R-W · Turn Boundary')
      // Waiting: the completion notification IS the wait.
      expect(persona).toContain('let the subagent completion notification wake you')
      expect(persona).toContain('Never run sleep, polling loops, watch')
      expect(persona).toContain('job_output({ wait: true })')
      // An incompatible session never reaches this rule, so there is no
      // teammate wait channel to name.
      expect(persona).not.toContain('wait_agent()')
      // No self-appointed wake-up call during the wait.
      expect(persona).toContain('[Goals] Do not proactively create goals')
      expect(persona).toContain('never call create_goal or /goal')
      expect(persona).toContain('in todo_write, not create_goal; see R-W')
      // A blocked-on decision is a question, not a paragraph.
      expect(persona).toContain('hand the question out with ONE code_run program containing exactly one tools.ask_user_question(...) sub-call')
      expect(persona).toContain('The same rule covers every decision stop outside the interview')
      // Plan-mode approval keeps its own channel; a finished task asks nothing.
      expect(persona).toContain('Only two exceptions: plan-mode approval still goes through tools.exit_plan_mode inside code_run')
      // The anti-patterns that let each of the three back in.
      expect(persona).toContain('placeholder long commands to wait')
      expect(persona).toContain('proactively calling create_goal')
      expect(persona).toContain('ending with prose instead of ask_user_question when blocked on a decision')
      // R-W is dispatch-side only, like every other coordinator rule.
      expect(persona).toContain('the coordinator-facing rules in R0, R-G, R1, R2, R4, R5, and R-W')
    }
  })

  it('makes list_subagent_models the sole source of the allowlist instead of local files', () => {
    // Field report (session-01724ca8): the dispatcher called list_subagent_models,
    // saw the generic upstream tool description ("list registered providers /
    // advertised models... Catalog membership is advisory"), and spent 9 turns
    // grepping the workspace for `subagentModelAuthorization` and scanning
    // `~/.dsh` config files to find the "real" allowlist. Both copies must
    // state that list_subagent_models IS the runtime-filtered allowlist,
    // spell out the two-step call, forbid local file/code hunting, and drop
    // the internal symbol name that baited the grep.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('the sole source of truth for the allowlist is list_subagent_models')
      expect(persona).toContain('Call list_subagent_models({}) to list authorized providers and routes')
      expect(persona).toContain('call list_subagent_models({ provider }) when you need model details under that provider')
      expect(persona).toContain('model without the <provider>/ prefix')
      expect(persona).toContain('trust its output directly without cross-checking local config files or workspace code')
      expect(persona).toContain('the runtime output is already filtered to this session\'s allowlist')
      expect(persona).toContain('hunting local config/source files to verify allowed subagent models')
      expect(persona).not.toContain('subagentModelAuthorization')
    }
  })

  it('reads the routing posture instead of inferring it from a mounted tool', () => {
    // The preset used to claim one signal was sufficient: "its presence and the
    // exposure of provider / model ... always appear or disappear together".
    // That is false. The tool row and the route parameters are mounted
    // statically (modelSelection: true, modelDiscovery: true), so they exist even in a session
    // that recorded no allowlist. Both copies must name all three states, say
    // which permits inheritance, and retain the parent-route caveat instead
    // of equating "no Session allowlist" with unrestricted explicit selection.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('[State: Listed]')
      expect(persona).toContain('[State: Unlisted]')
      expect(persona).toContain('[State: Unmounted]')
      // A deployment whose guard was never installed appends nothing at all, so
      // the rule needs a reading for "the annotation is absent": fall back to the
      // unlisted behaviour without claiming either posture.
      expect(persona).toContain('or says neither—treat as unconfirmed and never report a route as authorized')
      // The mechanism, stated as a fact rather than as a preference.
      expect(persona).toContain('mounted statically even when no route is authorized; read the posture from its output')
      // Fork's admission is the parent route, not the discovery tool: that is why
      // it survives the state where list_subagent_models is absent.
      expect(persona).toContain('still works when list_subagent_models is absent: try subagent_fork once and read the denial')
      expect(persona).toContain('never claim per-task routing is in force here')
      // The single-signal claim and the vocabulary that depended on it are gone.
      expect(persona).not.toContain('so this single signal is sufficient')
      expect(persona).not.toContain('[When Available]')
      expect(persona).not.toContain('[When Unavailable]')
      expect(persona).not.toContain('allowlist is empty and the user has not enabled it')
      expect(persona).toContain('claiming a route is authorized under [State: Unlisted]')
    }
  })

  it('ships both the released and current model-selection switches', () => {
    // The published 0.2.1-rc.3 package still reads only `modelSelectionSettings`;
    // the later source tree reads `modelSelection` and `modelDiscovery`. Removing
    // any of these rows disables dispatch on one side of that boundary.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    // Config rows, not the header comment that also names all three keys.
    expect(/^ {8}modelSelectionSettings: true$/mu.test(yml)).toBe(true)
    expect(/^ {8}modelSelection: true$/mu.test(yml)).toBe(true)
    expect(/^ {8}modelDiscovery: true$/mu.test(yml)).toBe(true)
    // The generated template must agree with the bundled file.
    expect(declaredPrefix()).toBeTypeOf('string')
  })

  it('writes caps where a range would be read as a floor', () => {
    // Behaviour probe result: a limit written as a range or as "at most N per
    // cycle" was read as its strictest meaning and never verified — 9/9 runs,
    // 18/18 cycles. The triage bounds and the re-dispatch budget must therefore
    // be written as caps with their unit and their counting rule, never as
    // ranges and never with two incompatible phrasings.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('edits at most 5 files (5 is a cap, not a range and not a target)')
      expect(persona).toContain('Ask at most 2 key questions (no full interview; 2 is the cap)')
      expect(persona).toContain('1 first attempt + at most 2 re-dispatches = at most 3 runs total')
      expect(persona).toContain('Count runs, not failures')
      // The old range/bare forms are gone from both copies.
      expect(persona).not.toContain('L1 Moderate: 2–5 files')
      expect(persona).not.toContain('Ask at most 1–2 key questions')
      expect(persona).not.toContain('Re-dispatch the same task brief at most twice')
      expect(persona).toContain('Writing range limits ("2–5 files") instead of caps')
    }
  })

  it('puts a limits ledger in every task brief', () => {
    // A subagent is a fresh instance of the same model and reads an ambiguous
    // limit the same way: strictest meaning, no verification. Five brief elements
    // named no limits at all, so every numeric bound in a brief was written in
    // whatever shape the dispatcher happened to use — and the blind-box probe
    // measured a ~240-point gap between an ambiguous rule set and a written-out
    // one. Both copies must require the sixth element, the four fields per limit,
    // explicit numeric caps, and must forbid the restatement ritual that
    // reproduces a misreading instead of catching it.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('six elements: Goal / Boundary')
      expect(persona).toContain('Limits (see below)')
      expect(persona).toContain('what it bounds, in what unit, the cap, and whether it accumulates')
      expect(persona).toContain('silence is read as a limit of zero')
      expect(persona).toContain('a quota that resets per cycle is lost, not banked')
      expect(persona).toContain('Do not ask the child to restate your rules back as a correctness check')
      expect(persona).toContain('asking a subagent to restate rules')
      // The five-element form is gone from both copies.
      expect(persona).not.toContain('must contain five elements')
    }
  })

  it('routes a noticed risk instead of only recording it', () => {
    // The路口 field report's largest single loss: vehicles it named as
    // red-light runners and then never released, all of which crashed. In this
    // mode the equivalent is a defect found in review, written into the delivery
    // summary, and shipped anyway. Both copies must give the two legal exits, deny
    // the summary-only exit, and treat the completion notification as the
    // post-hoc signal it is.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('[Noticed but not handled]')
      expect(persona).toContain('Writing it into the delivery summary and shipping anyway is not an available outcome')
      expect(persona).toContain('the defect goes back out on a re-dispatch with evidence')
      expect(persona).toContain('shipping a review defect by merely noting it in the summary')
      // The notification is a post-hoc signal, in both rules that touch it.
      expect(persona).toContain('The completion notification is a post-hoc signal')
      expect(persona).toContain('post-hoc signal')
      expect(persona).toContain('Treat it as "there is now something to review", never as "this passed"')
    }
  })

  it('scans for escalating items before each turn without turn-age clutter', () => {
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('[Before every turn]')
      expect(persona).toContain('Prioritize items that will escalate, expire, or time out before items that are merely large')
      expect(persona).toContain('do not list per-turn item ages in user replies')
      // The run count lives in the task list for delegated briefs, not in the coordinator's memory.
      expect(persona).toContain('each delegated task item carries its own run count')
      expect(persona).toContain('the number belongs in the task list item for that brief')
    }
  })

  it('keeps the plan-mode section full, byte-identical between YAML and declaration', () => {
    // The section is delivered ONCE, as a trailing notice message appended at
    // agent/pre-step (src/entry-plan-mode.ts), not re-rendered into
    // `systemPrompt` on every step of Plan Mode — so its length is no longer a
    // per-step resident cost and the full four-paragraph guidance is restored.
    // It is still the only guardrail on the manual /plan path — the degraded
    // entry R9 keeps for an older harness or a switched-off plugin row — where
    // no enter_plan_mode tool result ever arrives, so every paragraph has to
    // be present here.
    function planModeSectionOf(yml: string): string {
      const lines = yml.split('\n')
      const start = lines.findIndex(line => line.trim() === 'section: |')
      if (start < 0) throw new Error('agent.cordis.yml carries no "section: |" block')
      const block: string[] = []
      for (const line of lines.slice(start + 1)) {
        if (line.trim() === '') { block.push(''); continue }
        if (!line.startsWith('              ')) break
        block.push(line.slice(14))
      }
      return block.join('\n').replace(/\n+$/, '')
    }

    function declaredPlanModeSection(): string {
      const found = allRows().find(row => row.id === 'plan-mode')
      const config = found?.config as { section?: unknown } | undefined
      if (typeof config?.section !== 'string') throw new Error('the declaration carries no plan-mode section')
      return config.section.replace(/\n+$/, '')
    }

    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    const fromYaml = planModeSectionOf(yml)
    const fromDecl = declaredPlanModeSection()
    expect(fromYaml).toBe(fromDecl)
    for (const section of [fromYaml, fromDecl]) {
      expect(section).toContain('[Plan Mode]')
      expect(section).toContain('[Read-Only Exploration & Clarification Interview]')
      expect(section).toContain('[Plan Completeness]')
      expect(section).toContain('[Plan Approval]')
      // The two clauses the one-sentence version had dropped: the read-only
      // subagent route rule and the L1 interview cap.
      expect(section).toContain('using the routes returned directly by list_subagent_models')
      expect(section).toContain('keep the interview to at most 2 questions')
      // The range form that reads as a floor stays out even in the full text.
      expect(section).not.toContain('1–2 questions')
    }
    // The intent the old section-only assertions pinned by proxy still holds
    // where it now lives, so restoring the section cannot silently drop it:
    // the L1 question cap and the read-only discipline are in the persona, and
    // the subagent route rule is in R2/G4.
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('Ask at most 2 key questions')
      expect(persona).toContain('2 is the cap')
      expect(persona).toContain('Read-only exploration and the decision-complete plan belong to the next step')
      expect(persona).toContain('subagent model routes are provided directly by list_subagent_models')
    }
  })

  it('places the plan pipeline after the interview and states what the subagent gate can enforce', () => {
    // R9 is the reason the plan-mode-pipeline row exists: convergence enters
    // Plan Mode, the plan is written there, and approval goes through
    // exit_plan_mode. Both copies must carry it, or the two sides of the preset
    // teach different flows.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('## R9 · Plan Pipeline')
      expect(persona).toContain('enter_plan_mode')
      expect(persona).toContain('leave_plan_mode')
      expect(persona).toContain('exit_plan_mode')
      expect(persona).toContain('Call tools.enter_plan_mode inside ONE code_run immediately once that holds')
      expect(persona).toContain('ONE code_run containing only tools.exit_plan_mode must be the sole and final top-level tool call of the turn that submits the plan')
      // The degraded path when the tool is absent stays a question, never prose.
      expect(persona).toContain('the degraded path is ONE code_run program containing exactly one tools.ask_user_question(...) sub-call asking the user to enter /plan')
      // The anti-pattern pins both premature Plan Mode and leave-as-approval abuse.
      expect(persona).toContain('Opening Plan Mode for L0/L1/L2-Clear or before R-G convergence')
      expect(persona).toContain('using leave_plan_mode to bypass exit_plan_mode approval')
      expect(persona).toContain('never call plan-mode tools (rejected with DELEGATED_CALLER on supported hosts)')
      expect(persona).toContain('carry any open decision or Plan Mode request back to the dispatcher via status: hand_back')
      expect(persona).not.toContain('The bridge rejects a live child at execution time')
    }
  })

  it('keeps both shipped copies byte-identical and carries the dispatch upgrades in both', () => {
    // The preset ships twice: the YAML the legacy sync deploys and the
    // declaration 0.1.7 registers. A rule that reaches only one of them
    // teaches two different dispatch modes, and the plan-mode section is the
    // coordinator's only guardrail on the manual /plan path. So this test pins
    // the two texts against each other and pins the new rules into them.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')

    /** One `key: |` block of the YAML, dedented to the text the runtime mounts. */
    function blockOf(marker: string, indent: number): string {
      const lines = yml.split('\n')
      const start = lines.findIndex(line => line.trim() === marker)
      if (start < 0) throw new Error(`agent.cordis.yml carries no "${marker}" block`)
      const block: string[] = []
      for (const line of lines.slice(start + 1)) {
        if (line.trim() === '') { block.push(''); continue }
        if (!line.startsWith(' '.repeat(indent))) break
        block.push(line.slice(indent))
      }
      return block.join('\n').replace(/\n+$/, '')
    }

    /** One declared config string, without its trailing newlines. */
    function declaredText(id: string, key: 'prefix' | 'section'): string {
      const row = allRows().find(candidate => candidate.id === id)
      const config = row?.config as Record<string, unknown> | undefined
      const value = config?.[key]
      if (typeof value !== 'string') throw new Error(`the declaration carries no ${id} ${key}`)
      return value.replace(/\n+$/, '')
    }

    const prefix = declaredText('persona', 'prefix')
    const section = declaredText('plan-mode', 'section')

    // Parity: the declaration and the shipped file carry the same text.
    expect(prefix).toBe(blockOf('prefix: |', 6))
    expect(section).toBe(blockOf('section: |', 14))

    // The new dispatch rules, in the persona the coordinator actually reads.
    for (const rule of [
      'hand_back',
      'existing-standard',
      'Stop by Impact, Not by Effort',
      'Before',
      'After',
      'Clause Deletion Test',
      'DELEGATED_CALLER',
    ]) {
      expect(prefix).toContain(rule)
    }
    // The standing contract and the report protocol it names.
    expect(prefix).toContain('[Standing Subagent Contract]')
    expect(prefix).toContain('[Subagent Report Protocol]')
    expect(prefix).toContain('[Coordinator-Only Tools]')
    expect(prefix).toContain('status: ready | hand_back | blocked | failed | dropped')
    expect(prefix).toContain('hand_back_reason')
    expect(prefix).toContain('no per-cycle banking')
    expect(prefix).toContain('at most 3 execution runs per brief including the initial run')
    expect(prefix).toContain('at most 2 consecutive model steps without new evidence')
    expect(prefix).toContain('minimum sufficient evidence')
    // A clean hand_back is a scope routing event, not a failed run.
    expect(prefix).toContain('does not increment a failure count or trigger R8 by itself')
    expect(prefix).toContain('send_message({ agent })')
    // Minimal native whitelist and the program-only question/plan contract.
    expect(prefix).toContain('[Dispatch Native Tool Whitelist]')
    expect(prefix).toContain('Top-level: only code_run, cache_warmup_result, dispatch_ledger, progress_update, and structured_output')
    expect(prefix).toContain('Every task tool—including win_bash—is program-only')
    expect(prefix).not.toContain('structured_output, win_bash')
    expect(prefix).toContain('Q1/G4 are rule ids, never argument-key suffixes')
    expect(prefix).not.toContain('hand the question out with a single ask_user_question call')
    // The compact brief form and the three new anti-patterns.
    expect(prefix).toContain('Compact Delta Brief')
    expect(prefix).toContain('use a Compact Delta Brief by default')
    // Dual-track Code Mode wording: no stale PTC-only parentheticals remain.
    expect(prefix).not.toContain('Criterion: whether spawn_teammate exists')
    expect(prefix).toContain('frozen declaration, not availability')
    expect(prefix).toContain('Dispatch independent tasks concurrently through code_run Promise.all')
    expect(prefix).toContain('ordinary code_run programs should batch independent read/search/tool calls')
    expect(prefix).toContain('L2-Clear')
    expect(prefix).toContain('L2-Governed')
    expect(prefix).toContain('One acceptance layer owned by Lead')
    expect(prefix).not.toContain('(PTC: tools.spawn_teammate)')
    expect(prefix).not.toContain('stay visible in the PTC SDK')
    expect(prefix).not.toContain('(in PTC mode: tools.list_subagent_models)')
    expect(prefix).not.toContain('(via Promise.all in PTC mode)')
    // Slimmed resident prefix budget (<15500 chars, down from ~19000).
    expect(prefix.length).toBeLessThan(15500)
    expect(prefix).toContain('Asking the user about settled repo/external standards (existing-standard)')
    expect(prefix).toContain('search the web (GitHub docs/repos, official docs, research papers, specs) to avoid reinventing the wheel')
    expect(section).toContain('external prior art (GitHub docs/repos, official docs, research papers, specs)')
    expect(section).toContain('never reinvent the wheel')
    expect(prefix).toContain('penalizing a clean status: hand_back as a failed run')
    expect(prefix).toContain('accepting regression-risk UI changes without Before & After (or After-only note)')

    // The plan-mode section is the coordinator's own guardrail: it carries the
    // exemption and the visual-evidence gate the plan itself has to name.
    expect(section).toContain('existing-standard')
    expect(section).toContain('Before and After visual evidence')
    expect(section).toContain('with no reliable Before, an After plus a note suffices')

    // L2 decouples full governance from execution topology (Lead-Core / Hybrid /
    // Fan-out) and remains strictly model- and provider-agnostic.
    for (const topology of ['Lead-Core', 'Hybrid', 'Fan-out']) {
      expect(prefix).toContain(topology)
      expect(section).toContain(topology)
    }
    for (const text of [prefix, section]) {
      expect(text).not.toMatch(/k3\.1-pro|kimi-code|Kimi Code|gpt-5|claude-opus|deepseek-v/i)
    }
  })
})

describe('the bundled files the declaration transcribes', () => {
  it('still ships the preset the declaration stands in for', () => {
    expect(existsSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'preset.yml'))).toBe(true)
  })
})

