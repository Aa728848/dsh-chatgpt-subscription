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
    // The pruner row is deliberately absent: rewriting a historical tool result
    // invalidates the provider's content-prefix cache from there to the end, so
    // the rebuild it triggers costs more than the context it removes.
    expect(nestedIds('compaction')).toEqual(['compaction-basic', 'command-compact'])
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
      isolate: { compaction: true },
    })
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
    expect(rowById('tool-presentation').config).toEqual({ mode: 'ptc' })
    expect(rowById('persona').config).toMatchObject({ suffix: 'Your working directory is {{cwd}}.' })
    expect((rowById('persona').config as { prefix: string }).prefix).not.toContain('{{cwd}}')
  })

  it('strips persona.config.suffix on >=0.2.1 where @deepseek-ai/dsh-working-directory replaces {{cwd}}', async () => {
    expect(resolveDispatchPreset(specifier => specifier === '@deepseek-ai/dsh-tool-subagent-control/list-agents')).toBe(DISPATCH_PRESET)
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
      ctx.systemPrompt.variable('model', () => 'gpt-5.4')
      const rendered = SystemPromptModule.renderPrompt(await ctx.systemPrompt.assemble())
      expect(rendered).toContain('You are powered by gpt-5.4.')
      expect(rendered).not.toContain('{{cwd}}')
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
  it('registers the unmodified definition on 0.1.7-0.2.0 and the suffix-stripped definition on >=0.2.1', async () => {
    const pre021 = fakeRegistry()
    const pre021Host = fakeHost({ agentPresets: pre021.registry })

    expect(installDispatchPreset(pre021Host.host, specifier => specifier === PRESET_REGISTRY_PACKAGE
      || specifier === '@deepseek-ai/dsh-tool-subagent-control/list-agents')).toBe('registered')
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
      expect(persona).toContain('Carrying a one-off fallback forward as the default for the rest of the session')
      expect(persona).toContain('Using a tool hard-rejection as a fallback excuse instead of fixing its trigger condition')
      // The condition-fix guidance for the two hard rejections seen in the field.
      expect(persona).toContain('active child limit')
      expect(persona).toContain('subagent model selection')
      // The old unbounded wording, which let the model declare an open-ended
      // session-wide fallback, must be gone from both copies.
      expect(persona).not.toContain('子代理连续失败')
      expect(persona).not.toContain('只有这些情况你才亲自执行')
    }
  })

  it('refuses to orchestrate under Agent Teams instead of adapting to it', () => {
    // The field report: with the Agent Teams bundle composed, the preset kept
    // dispatching while the team-scoped send_message / list_agents /
    // interrupt_agent shadowed the subagent ones — children became invisible
    // and unreachable, and the "switch vocabulary" branch made that failure
    // silent instead of loud. Both copies must stop at a compatibility gate
    // and hand the decision to the user; the degraded branch must be gone
    // from both, in every spelling it ever had.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      // Detection survives unchanged, and still runs before triage.
      expect(persona).toContain('## R0.5 · Compatibility Gate')
      expect(persona).toContain('whether spawn_teammate and wait_agent exist')
      // The incompatibility is stated as a mechanism, not a preference...
      expect(persona).toContain('Dispatch Mode is **incompatible** with Agent Teams')
      expect(persona).toContain('replaces send_message, list_agents, and interrupt_agent')
      // ...and it gates the WHOLE flow rather than selecting a vocabulary.
      expect(persona).toContain('This session is **not orchestratable**')
      expect(persona).toContain('do not triage, plan, dispatch, touch files')
      // The exit is the user's, taken through the question tool (R-W).
      expect(persona).toContain('Call ask_user_question once to hand the choice of exit path to the user')
      // And the fix needs a new session: this one's tool surface is fixed.
      expect(persona).toContain('**must start a new session** for it to take effect')
      // The anti-patterns that let the old degraded branch back in.
      expect(persona).toContain('Switching to teammate vocabulary to keep orchestrating when Agent Teams is detected')
      expect(persona).toContain('Explaining an incompatibility in plain text and leaving the user to figure out the exit path')
      // No trace of the vocabulary switch remains in either copy.
      expect(persona).not.toContain('## R-T')
      expect(persona).not.toContain('team_task_*')
      expect(persona).not.toContain('wait_agent()')
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
      expect(persona).toContain('hand the question out with a single ask_user_question call')
      expect(persona).toContain('The same rule covers every decision stop outside the interview')
      // Plan-mode approval keeps its own channel; a finished task asks nothing.
      expect(persona).toContain('Only two exceptions: plan-mode approval still goes through exit_plan_mode')
      // The anti-patterns that let each of the three back in.
      expect(persona).toContain('placeholder long commands to wait')
      expect(persona).toContain('Proactively creating a goal at the start of a task')
      expect(persona).toContain('Ending with a paragraph of prose to wait for user sign-off')
      // R-W is dispatch-side only, like every other coordinator rule.
      expect(persona).toContain('the coordinator-facing rules in R0, R0.5, R-G, R1, R2, R4, R5, and R-W')
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
      expect(persona).toContain('The sole source of truth for the allowlist is list_subagent_models')
      expect(persona).toContain('call list_subagent_models({}) to list authorized providers')
      expect(persona).toContain('call list_subagent_models({ provider }) to list authorized models under that provider')
      expect(persona).toContain('model without the <provider>/ prefix')
      expect(persona).toContain('trust its output directly without cross-checking local config files or workspace code')
      expect(persona).toContain('Catalog membership is advisory')
      expect(persona).toContain('the runtime output is already filtered to this session\'s allowlist')
      expect(persona).toContain('Second-guessing list_subagent_models output by hunting through local config or source files just to check which subagent models are allowed')
      expect(persona).not.toContain('subagentModelAuthorization')
    }
  })

  it('reads the routing posture instead of inferring it from a mounted tool', () => {
    // The preset used to claim one signal was sufficient: "its presence and the
    // exposure of provider / model ... always appear or disappear together".
    // That is false. The tool row and the route parameters are mounted
    // statically (modelSelection: true, modelDiscovery: true), so they exist even in a session
    // that recorded no allowlist, while the guard reads the recorded policy
    // (effectiveAllowedRoutes) and enforces nothing without one. Both copies must
    // name all three states, say which of them permits fallback, and drop the
    // single-signal claim.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('[State: Listed]')
      expect(persona).toContain('[State: Unlisted]')
      expect(persona).toContain('[State: Unmounted]')
      // A deployment whose guard was never installed appends nothing at all, so
      // the rule needs a reading for "the annotation is absent": fall back to the
      // unlisted behaviour without claiming either posture.
      expect(persona).toContain('If the output says neither')
      expect(persona).toContain('the annotation is absent and you cannot read the posture')
      expect(persona).toContain('say "unconfirmed" rather than claiming either posture')
      // The mechanism, stated as a fact rather than as a preference.
      expect(persona).toContain('mounted statically, so they are present even in a session that authorized no route at all')
      expect(persona).toContain('Read that fact instead of inferring it')
      // Fork's admission is the parent route, not the discovery tool: that is why
      // it survives the state where list_subagent_models is absent.
      expect(persona).toContain('its admission is decided by the route the calling session is actually running')
      expect(persona).toContain('so it still works when list_subagent_models is absent')
      expect(persona).toContain('try subagent_fork once and read the denial')
      expect(persona).toContain('Never claim per-task routing is in force here')
      // The single-signal claim and the vocabulary that depended on it are gone.
      expect(persona).not.toContain('so this single signal is sufficient')
      expect(persona).not.toContain('[When Available]')
      expect(persona).not.toContain('[When Unavailable]')
      expect(persona).not.toContain('allowlist is empty and the user has not enabled it')
      expect(persona).toContain('Reporting a route as "authorized", or claiming per-task routing is in force')
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
      expect(persona).toContain('Writing a task brief with a range where a cap belongs')
    }
  })

  it('puts a limits ledger in every task brief', () => {
    // A subagent is a fresh instance of the same model and reads an ambiguous
    // limit the same way: strictest meaning, no verification. Five brief elements
    // named no limits at all, so every numeric bound in a brief was written in
    // whatever shape the dispatcher happened to use — and the blind-box probe
    // measured a ~240-point gap between an ambiguous rule set and a written-out
    // one. Both copies must require the sixth element, the four fields per limit,
    // the explicit "unlimited", and must forbid the restatement ritual that
    // reproduces a misreading instead of catching it.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('six elements: Goal / Boundary')
      expect(persona).toContain('Limits (see below)')
      expect(persona).toContain('what it bounds, in what unit, the cap, and whether it accumulates')
      expect(persona).toContain('silence is read as a limit of zero')
      expect(persona).toContain('a quota that resets per cycle is lost, not banked')
      expect(persona).toContain('Do not ask the child to restate your rules back as a correctness check')
      expect(persona).toContain('Asking a subagent to restate its rules as a correctness check')
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
      expect(persona).toContain('Shipping a defect you already named in the review')
      // The notification is a post-hoc signal, in both rules that touch it.
      expect(persona).toContain('The notification is a post-hoc signal')
      expect(persona).toContain('The completion notification is a post-hoc signal')
      expect(persona).toContain('Treat it as "there is now something to review", never as "this passed"')
    }
  })

  it('scans for escalating items before each turn', () => {
    // The one prompt that measurably worked in the behaviour probe: "find the
    // items that will escalate, expire or time out this turn and handle those
    // first" took escalations from 3.67 per run to 0. Without it a
    // low-priority backlog is what eventually turns into the incident.
    const yml = readFileSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'), 'utf8')
    for (const persona of [personaBlockOf(yml), declaredPrefix()]) {
      expect(persona).toContain('[Before every turn]')
      expect(persona).toContain('will escalate, expire, or time out if you do nothing this turn')
      expect(persona).toContain('handle those before the items that are merely large')
      expect(persona).toContain('an item that is fine')
      expect(persona).toContain('listed with its age in turns')
      // The run count lives in the task list, not in the coordinator's memory.
      expect(persona).toContain('Each task item carries its own run count')
      expect(persona).toContain('the number belongs in the task list item for that brief')
    }
  })

  it('keeps the plan-mode section byte-identical between YAML and declaration and aligned with R0/R-G/R2', () => {
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
      expect(section).toContain('using the routes returned directly by list_subagent_models')
      expect(section).toContain('exit_plan_mode')
      // The plan-mode interview bound must agree with R0's cap, and must not
      // reintroduce the range form that reads as a floor.
      expect(section).toContain('keep the interview to at most 2 questions')
      expect(section).not.toContain('1–2 questions')
    }
  })
})

describe('the bundled files the declaration transcribes', () => {
  it('still ships the preset the declaration stands in for', () => {
    expect(existsSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(bundledPresetsRoot(), DISPATCH_PRESET_ID, 'preset.yml'))).toBe(true)
  })
})

