/**
 * The model-facing `cline_pass_*` management tools.
 *
 * They read and write the same settings file the provider runs from, so a pin
 * written here takes effect on the very next model call. Registration is
 * optional and read at startup (see `exposeTools`): eight definitions are several
 * kilobytes of schema riding in every request's tool list, and a conversation
 * that never manages the route does not need them.
 *
 * @module dsh-chatgpt-subscription/cline-pass-tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { normalizePinMode, pinWarnings } from './protocol.ts'
import type { ClinePassAccountPool } from './account-pool.ts'
import type { ClinePassEngine } from './engine.ts'
import type { ClinePassStore } from './store.ts'
import type { ClinePassModelSettingsStore } from './token-store.ts'
import { bearerFor } from './token-store.ts'
import { DEFAULT_MODELS, defaultPin, type ClinePassPinSettings } from './types.ts'
import type { ClinePassWebStatus } from '../../shared/cline-pass-contracts.ts'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function firstLine(value: unknown, max = 200): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Human label for one upstream availability verdict. */
const STATUS_LABEL: Record<string, string> = {
  ok: 'available',
  limited: 'rate-limited',
  bad: 'not-pinnable',
  auth: 'auth-failed',
  'not-adopted': 'not-adopted',
  unknown: 'unknown',
}

const statusLabel = (status: string): string => STATUS_LABEL[status] ?? String(status ?? 'unknown')

const ACCOUNT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    alias: { type: 'string', required: true },
    isPrimary: { type: 'boolean', required: true },
    enabled: { type: 'boolean', required: true },
    cooldownUntil: { type: 'integer' },
    authStatus: { type: 'string' },
  },
} as const

const TRACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    upstream: { type: 'string', required: true },
    status: { type: 'integer', required: true },
    ms: { type: 'integer', required: true },
    note: { type: 'string', required: true },
  },
} as const

const VALIDATE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    upstream: { type: 'string', required: true },
    status: { type: 'string', required: true },
    ms: { type: 'integer', required: true },
    note: { type: 'string', required: true },
  },
} as const

const MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    displayName: { type: 'string', required: true },
    pipeline: { type: 'string', required: true },
    pinnable: { type: 'boolean', required: true },
    hidden: { type: 'boolean', required: true },
    pinMode: { type: 'string', required: true },
    sort: { type: 'string', required: true },
    pinned: { type: 'array', required: true, items: { type: 'string' } },
    excluded: { type: 'array', required: true, items: { type: 'string' } },
    upstreams: { type: 'array', required: true, items: { type: 'string' } },
    upstreamStatus: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          upstream: { type: 'string', required: true },
          status: { type: 'string', required: true },
          ms: { type: 'integer', required: true },
          note: { type: 'string', required: true },
          checkedAt: { type: 'integer', required: true },
        },
      },
    },
    lastProvider: { type: 'string', required: true },
    lastMs: { type: 'integer', required: true },
    probedAt: { type: 'integer', required: true },
    validatedAt: { type: 'integer', required: true },
  },
} as const

/** Project one model from the status payload the card already renders. */
function projectModel(status: ClinePassWebStatus, model: string) {
  const entry = status.models.find((candidate) => candidate.id === model)
  if (entry === undefined) return null
  return {
    id: entry.id,
    displayName: entry.name.replace(/^cline-pass\//, ''),
    pipeline: entry.pipeline,
    pinnable: entry.pinnable,
    hidden: !entry.enabled,
    pinMode: normalizePinMode(entry.pinMode),
    sort: entry.sort,
    pinned: entry.pinned,
    excluded: entry.excluded,
    upstreams: entry.upstreams,
    upstreamStatus: entry.upstreamStatus.map((verdict) => ({
      upstream: verdict.upstream,
      status: verdict.status,
      ms: Math.round(verdict.ms),
      note: verdict.note,
      checkedAt: Math.round(verdict.checkedAt),
    })),
    lastProvider: entry.lastProvider,
    lastMs: Math.round(entry.lastMs),
    probedAt: Math.round(entry.probedAt),
    validatedAt: Math.round(entry.validatedAt),
  }
}

export interface ClinePassToolsOptions {
  settings: ClinePassModelSettingsStore
  accountPool: ClinePassAccountPool
  store: ClinePassStore
  engine: ClinePassEngine
  status(): Promise<ClinePassWebStatus>
  /** Whether the route is currently served by this plugin. */
  serving(): boolean
}

/**
 * Register every `cline_pass_*` tool.
 * @returns one disposer bundle, or an empty list when no tools service exists.
 */
export function registerClinePassTools(ctx: Context, options: ClinePassToolsOptions): Array<() => void> {
  const { settings, accountPool, store, engine, status, serving } = options
  const disposers: Array<() => void> = []
  const pinOf = async (model: string): Promise<ClinePassPinSettings> => (await settings.read()).pins[model] ?? defaultPin()

  // ── cline_pass_status ─────────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_status',
    description: 'Report the Cline Pass provider state: route, accounts and whether each key is stored, account mode, model and pin counts. Read-only and free. Check this first when a Cline Pass model fails.',
    parameters: {},
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          displayName: { type: 'string', required: true },
          baseURL: { type: 'string', required: true },
          routeRegistered: { type: 'boolean', required: true },
          accountMode: { type: 'string', required: true },
          accounts: { type: 'array', required: true, items: ACCOUNT_SCHEMA },
          knownModels: { type: 'integer', required: true },
          pinnedModels: { type: 'integer', required: true },
          probedModels: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => text([
        `${value.displayName} provider "cline-pass" @ ${value.baseURL}`,
        `route registered=${value.routeRegistered}`,
        `accountMode=${value.accountMode}`,
        `accounts (${value.accounts.length}):`,
        ...value.accounts.map((account) => `  ${account.alias} (${account.id})${account.enabled ? '' : ' (disabled)'}${account.authStatus ? ` [${account.authStatus}]` : ''}`),
        `models: known=${value.knownModels} pinned=${value.pinnedModels} probed=${value.probedModels}`,
      ].join('\n')),
    },
    async execute() {
      const current = await status()
      return {
        provider: 'cline-pass',
        displayName: 'Cline Pass',
        baseURL: current.baseURL,
        routeRegistered: serving(),
        accountMode: current.pool.rotationStrategy,
        accounts: current.pool.accounts.map((account) => ({
          id: account.id,
          alias: account.alias,
          isPrimary: account.isPrimary,
          enabled: account.authStatus === undefined || account.authStatus === 'ok',
          ...(account.cooldownUntil === undefined ? {} : { cooldownUntil: Math.round(account.cooldownUntil) }),
          ...(account.authStatus === undefined ? {} : { authStatus: account.authStatus }),
        })),
        knownModels: current.models.length,
        pinnedModels: current.models.filter((model) => model.pinned.length > 0).length,
        probedModels: current.models.filter((model) => model.probedAt > 0).length,
      }
    },
  })))

  // ── cline_pass_models ─────────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_models',
    description: 'List the Cline Pass models with their pipeline, discovered channels, per-channel verdicts, visibility and stored pin. Pass `model` to filter by substring, `refresh: true` to rescan the official model list, `model` + `visible` to show/hide one model in every picker, or `mode` to show/hide them all at once. Free unless `refresh` is set.',
    parameters: {
      model: { type: 'string', description: 'Only return models whose id contains this text, e.g. "glm-5.2".' },
      refresh: { type: 'boolean', description: 'Rescan the official model list first and adopt new ids.' },
      visible: { type: 'boolean', description: 'With `model` (an exact id): true offers it in the model pickers again, false hides it. Hiding never removes it from the subscription list.' },
      mode: { type: 'string', description: 'Bulk visibility: "all" shows every subscription model, "none" hides every one, "invert" swaps the two. One write, so the set can never half-apply.' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          models: { type: 'array', required: true, items: MODEL_SCHEMA },
          catalogCount: { type: 'integer', required: true },
          catalogSources: { type: 'array', required: true, items: { type: 'string' } },
          catalogFetchedAt: { type: 'integer', required: true },
          added: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const blocks = value.models.map((model) => {
          const lines = [
            `${model.id}  pipeline=${model.pipeline || 'unknown'}${model.pinnable ? '' : ' (not pinnable)'}${model.hidden ? ' (hidden from pickers)' : ''}`,
            `  pinned=${model.pinned.length === 0 ? '(auto)' : model.pinned.join(' > ')} mode=${model.pinMode}${model.sort === '' ? '' : ` sort=${model.sort}`}${model.excluded.length === 0 ? '' : ` excluded=${model.excluded.join(',')}`}`,
          ]
          if (model.upstreams.length > 0) {
            const verdicts = new Map(model.upstreamStatus.map((entry) => [entry.upstream, entry.status]))
            lines.push(`  upstreams: ${model.upstreams.map((upstream) => `${upstream}[${statusLabel(verdicts.get(upstream) ?? 'unknown')}]`).join(' ')}`)
          } else {
            lines.push('  upstreams: (unknown — run cline_pass_probe for this model)')
          }
          if (model.lastProvider !== '') lines.push(`  last=${model.lastProvider} (${model.lastMs}ms)`)
          return lines.join('\n')
        })
        const head = `${value.models.length} Cline Pass model(s); official catalog=${value.catalogCount}${value.catalogSources.length === 0 ? '' : ` via ${value.catalogSources.join(',')}`}`
        const added = value.added.length === 0 ? [] : [`newly adopted: ${value.added.join(', ')}`]
        return text([head, ...added, ...blocks].join('\n\n'))
      },
    },
    async execute(args) {
      let added: string[] = []
      if (args.refresh === true) {
        const scan = await engine.officialModels()
        const current = await settings.read()
        const known = new Set(current.catalogModels.map((entry) => entry.id))
        const merged = [...current.catalogModels]
        for (const id of scan.models) {
          if (known.has(id)) continue
          added.push(id)
          const published = scan.catalog[id] ?? {}
          merged.push({
            id,
            ...(published.name === undefined ? {} : { name: published.name }),
            ...(published.contextWindow === undefined ? {} : { contextWindow: published.contextWindow }),
            ...(published.maxTokens === undefined ? {} : { maxTokens: published.maxTokens }),
            ...(published.reasoning === undefined ? {} : { reasoning: published.reasoning }),
            ...(published.input === undefined && published.inputModalities === undefined ? {} : { input: published.input ?? published.inputModalities }),
            ...(published.efforts === undefined ? {} : { efforts: published.efforts }),
          })
        }
        await settings.storeCatalog(merged)
        store.setCatalog({ ids: scan.models, sources: scan.sources, models: scan.catalog as Record<string, unknown> })
      }
      const current = await settings.read()
      if (typeof args.mode === 'string' && args.mode !== '') {
        const all = currentModelsForVisibility(current)
        const hidden = new Set(current.hiddenModels)
        const next = all.filter((id) => {
          const wasHidden = hidden.has(id)
          return args.mode === 'all' ? false : args.mode === 'none' ? true : !wasHidden
        })
        await settings.update({ hiddenModels: next })
      } else if (typeof args.visible === 'boolean') {
        const target = String(args.model ?? '').trim()
        const all = currentModelsForVisibility(current)
        if (!all.includes(target)) throw new Error(`${JSON.stringify(target)} is not one of this route's subscription models`)
        const hidden = new Set(current.hiddenModels)
        if (args.visible) hidden.delete(target)
        else hidden.add(target)
        await settings.update({ hiddenModels: [...hidden] })
      }
      const after = await status()
      const needle = String(args.model ?? '').trim().toLowerCase()
      const models = after.models
        .filter((model) => needle === '' || model.id.toLowerCase().includes(needle))
        .map((model) => projectModel(after, model.id))
        .filter((model): model is NonNullable<typeof model> => model !== null)
      const catalog = store.catalog()
      return {
        models,
        catalogCount: catalog.ids.length,
        catalogSources: catalog.sources,
        catalogFetchedAt: Math.round(catalog.fetchedAt),
        added,
      }
    },
  })))

  // ── cline_pass_probe ──────────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_probe',
    description: 'Detect how one model is routed and harvest its pinnable upstream channels, with one tiny real request. Run it before pinning, and again when a pin that used to work stops working.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id, e.g. "cline-pass/glm-5.2".' },
    },
    timeoutMs: 600_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          error: { type: 'string', required: true },
          ms: { type: 'integer', required: true },
          pipeline: { type: 'string', required: true },
          pinnable: { type: 'boolean', required: true },
          canonicalSlug: { type: 'string', required: true },
          lastProvider: { type: 'string', required: true },
          upstreams: { type: 'array', required: true, items: { type: 'string' } },
          availableProviders: { type: 'array', required: true, items: { type: 'string' } },
          tier0: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return text(`probe ${value.model} failed: ${value.error}`)
        return text([
          `probe ${value.model}: ok in ${value.ms}ms`,
          `pipeline=${value.pipeline} pinnable=${value.pinnable} canonicalSlug=${value.canonicalSlug || '-'} lastProvider=${value.lastProvider || '-'}`,
          value.upstreams.length === 0 ? 'upstreams: (none discovered)' : `upstreams (${value.upstreams.length}): ${value.upstreams.join(', ')}`,
          value.tier0.length === 0 ? '' : `tier0: ${value.tier0.join(', ')}`,
        ].filter((line) => line !== '').join('\n'))
      },
    },
    async execute(args, exec) {
      const model = String(args.model).trim()
      const result = await engine.probe(model, { signal: exec.signal })
      return {
        ok: result.ok,
        model,
        error: firstLine(result.error, 400),
        ms: Math.round(result.ms),
        pipeline: result.pipeline,
        pinnable: result.pinnable,
        canonicalSlug: result.canonicalSlug,
        lastProvider: result.lastProvider,
        upstreams: result.upstreams,
        availableProviders: result.availableProviders,
        tier0: result.tier0,
      }
    },
  })))

  // ── cline_pass_validate ───────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_validate',
    description: 'Test every known channel of one model, one tiny real request each, and report a verdict per channel: available, rate-limited, not-pinnable, or auth-failed. This is the ground truth behind a pin. Probe the model first so its channel list exists.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id, e.g. "cline-pass/glm-5.2".' },
    },
    timeoutMs: 1_800_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          error: { type: 'string', required: true },
          summary: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              ok: { type: 'integer', required: true },
              limited: { type: 'integer', required: true },
              bad: { type: 'integer', required: true },
              auth: { type: 'integer', required: true },
              unknown: { type: 'integer', required: true },
            },
          },
          results: { type: 'array', required: true, items: VALIDATE_RESULT_SCHEMA },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return text(`validate ${value.model} failed: ${value.error}`)
        return text([
          `validate ${value.model}: ${value.results.length} upstream(s)`,
          `available=${value.summary.ok} rate-limited=${value.summary.limited} not-pinnable=${value.summary.bad} auth-failed=${value.summary.auth} unknown=${value.summary.unknown}`,
          ...value.results.map((entry) => `${entry.upstream}: ${statusLabel(entry.status)} (${entry.ms}ms)${entry.note === '' ? '' : ` — ${entry.note}`}`),
        ].join('\n'))
      },
    },
    async execute(args, exec) {
      const model = String(args.model).trim()
      const meta = store.metaOf(model)
      if (!Array.isArray(meta.upstreams) || meta.upstreams.length === 0) {
        return {
          ok: false,
          model,
          error: 'no known upstream channels: run cline_pass_probe for this model first',
          summary: { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 },
          results: [],
        }
      }
      const outcome = await engine.validate(model, { signal: exec.signal })
      return {
        ok: true,
        model,
        error: '',
        summary: outcome.summary,
        results: outcome.results.map((result) => ({ upstream: result.upstream, status: result.status, ms: Math.round(result.ms), note: result.note.slice(0, 160) })),
      }
    },
  })))

  // ── cline_pass_test ───────────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_test',
    description: 'Send one small real request through a pin and report which upstream served it, with the failover trace. `upstreams` and `exclude` override the stored pin for this call only; omit both to exercise it as stored. Nothing is persisted.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id, e.g. "cline-pass/glm-5.2".' },
      upstreams: { type: 'array', items: { type: 'string' }, description: 'Ordered upstream candidates for this call only.' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Upstream channels to exclude for this call only.' },
    },
    timeoutMs: 600_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          error: { type: 'string', required: true },
          ms: { type: 'integer', required: true },
          actual: { type: 'string', required: true },
          pipeline: { type: 'string', required: true },
          account: { type: 'string', required: true },
          adherence: { type: 'string', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          trace: { type: 'array', required: true, items: TRACE_SCHEMA },
        },
      },
      render: (_args, value) => {
        const trace = value.trace.map((entry) => `  ${entry.upstream} -> HTTP ${entry.status} in ${entry.ms}ms${entry.note === '' ? '' : ` — ${entry.note}`}`)
        return text([
          value.ok ? `test ${value.model}: ok in ${value.ms}ms via ${value.actual || '(unknown)'}` : `test ${value.model}: FAILED — ${value.error}`,
          ...value.warnings.map((warning) => `⚠ ${warning}`),
          trace.length === 0 ? '' : `attempts (${trace.length}):`,
          ...trace,
        ].filter((line) => line !== '').join('\n'))
      },
    },
    async execute(args, exec) {
      const model = String(args.model).trim()
      const result = await engine.test(model, {
        upstreams: Array.isArray(args.upstreams) ? args.upstreams.map(String) : undefined,
        exclude: Array.isArray(args.exclude) ? args.exclude.map(String) : undefined,
        signal: exec.signal,
      })
      return {
        ok: result.ok,
        model,
        error: firstLine(result.error, 400),
        ms: Math.round(result.ms),
        actual: result.actual,
        pipeline: result.pipeline,
        account: result.account,
        adherence: result.adherence,
        warnings: result.warnings,
        trace: result.trace.map((entry) => ({ upstream: entry.upstream, status: entry.status, ms: Math.round(entry.ms), note: entry.note.slice(0, 160) })),
      }
    },
  })))

  // ── cline_pass_pin ────────────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_pin',
    description: 'Persist one model\'s upstream pin. `upstreams` is the ordered candidate list, primary first (an empty array returns the model to automatic routing); `exclude` lists channels that must never be used, compiled into an allow-list on the wire because the gateway ignores an ignore-field; `pinMode` is "strict" or "preferred"; `sort` orders candidates by "cost", "ttft" or "tps" ("none" clears it). Only the fields you supply change. Returns `warnings` when a name cannot be checked or an exclusion cannot be expressed.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id, e.g. "cline-pass/glm-5.2".' },
      upstreams: { type: 'array', items: { type: 'string' }, description: 'Ordered pin list; an empty array clears pinning.' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Channels that must never be used.' },
      pinMode: { type: 'string', enum: ['strict', 'preferred'], description: 'How strictly to honor the pin list.' },
      sort: { type: 'string', enum: ['cost', 'ttft', 'tps', 'none'], description: 'Reorder candidates by this metric; "none" clears it.' },
    },
    timeoutMs: 30_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          model: { type: 'string', required: true },
          pinned: { type: 'array', required: true, items: { type: 'string' } },
          excluded: { type: 'array', required: true, items: { type: 'string' } },
          pinMode: { type: 'string', required: true },
          sort: { type: 'string', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => text([
        `pinned ${value.model}`,
        `upstreams: ${value.pinned.length === 0 ? '(auto)' : value.pinned.join(' > ')}`,
        `exclude: ${value.excluded.length === 0 ? '(none)' : value.excluded.join(', ')}`,
        `pinMode=${value.pinMode} sort=${value.sort === '' ? 'none' : value.sort}`,
        ...value.warnings.map((warning) => `⚠ ${warning}`),
      ].join('\n')),
    },
    async execute(args) {
      const model = String(args.model).trim()
      const current = await pinOf(model)
      const next: ClinePassPinSettings = {
        upstreams: Array.isArray(args.upstreams) ? args.upstreams.map(String) : current.upstreams,
        exclude: Array.isArray(args.exclude) ? args.exclude.map(String) : current.exclude,
        pinMode: args.pinMode !== undefined ? (args.pinMode === 'preferred' ? 'preferred' : 'strict') : current.pinMode,
        sort: args.sort === undefined ? current.sort : (args.sort === 'none' ? '' : String(args.sort)),
      }
      await settings.setPin(model, next)
      const meta = store.metaOf(model)
      const known = Array.isArray(meta.upstreams) ? meta.upstreams.map(String) : []
      const warnings = [...pinWarnings({ upstream: next.upstreams[0] ?? null, excludeList: next.exclude }, meta)]
      const named = [...next.upstreams, ...next.exclude]
      if (named.length > 0) {
        if (known.length === 0) {
          warnings.push(`unverifiedChannel: this model has no discovered channel list yet, so ${named.join(', ')} cannot be checked — run cline_pass_probe for it`)
        } else {
          const unknown = named.filter((name) => !known.includes(name))
          if (unknown.length > 0) warnings.push(`unknownChannel: ${unknown.join(', ')} is not in this model's discovered channel list (${known.join(', ')}); confirm with cline_pass_test, because the gateway ignores a channel it cannot use rather than failing`)
        }
      }
      return {
        ok: true,
        model,
        pinned: next.upstreams,
        excluded: next.exclude,
        pinMode: normalizePinMode(next.pinMode),
        sort: next.sort,
        warnings,
      }
    },
  })))

  // ── cline_pass_accounts ───────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_accounts',
    description: 'Manage the Cline Pass account pool: list, add, remove, switch rotation strategy, or test a key with one real request. Keys go to the encrypted credential store and are only ever shown as the alias.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'remove', 'mode', 'test'], description: 'Operation to perform.' },
      name: { type: 'string', description: 'Account id or alias, for remove/test.' },
      key: { type: 'string', description: 'API key (sk_…), for add/test.' },
      alias: { type: 'string', description: 'Human-readable label for a new account.' },
      baseURL: { type: 'string', description: 'Override the gateway address for this account; empty uses the provider address.' },
      mode: { type: 'string', enum: ['sequential', 'round-robin', 'sticky'], description: 'Pool rotation strategy.' },
    },
    timeoutMs: 180_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          note: { type: 'string', required: true },
          accounts: { type: 'array', required: true, items: ACCOUNT_SCHEMA },
        },
      },
      render: (_args, value) => text([
        `accounts.${value.action}: ${value.ok ? 'ok' : 'FAILED'}`,
        value.note === '' ? '' : `note: ${value.note}`,
        ...value.accounts.map((account) => `  ${account.alias} (${account.id})${account.enabled ? '' : ' (disabled)'}${account.authStatus ? ` [${account.authStatus}]` : ''}`),
      ].filter((line) => line !== '').join('\n')),
    },
    async execute(args) {
      const action = String(args.action)
      let note = ''
      let ok = true
      const current = await settings.read()
      const advertised = (await status()).models.find((model) => model.enabled)
      const model = advertised?.id ?? DEFAULT_MODELS[0] ?? 'cline-pass/glm-5.3-flash'
      if (action === 'add') {
        const key = String(args.key ?? '').trim()
        if (key === '') throw new Error('cline_pass_accounts action="add" needs a key')
        const alias = String(args.alias ?? args.name ?? '').trim()
        const baseURL = String(args.baseURL ?? '').trim()
        const account = await accountPool.addAccount({
          apiKey: key,
          addedAt: Date.now(),
          ...(alias === '' ? {} : { alias }),
          ...(baseURL === '' ? {} : { baseURL }),
        }, alias === '' ? undefined : alias)
        note = `added ${account.alias} (${account.id})`
      } else if (action === 'remove') {
        const target = String(args.name ?? '').trim()
        const accounts = await accountPool.listAccounts()
        const account = accounts.find((entry) => entry.id === target || entry.alias === target)
        if (account === undefined) throw new Error(`no account named ${JSON.stringify(target)}`)
        await accountPool.deleteAccount(account.id)
        note = `removed ${account.alias}`
      } else if (action === 'mode') {
        const mode = args.mode
        if (mode !== 'sequential' && mode !== 'round-robin' && mode !== 'sticky') {
          throw new Error('cline_pass_accounts action="mode" needs mode=sequential|round-robin|sticky')
        }
        await accountPool.setStrategy(mode)
        note = `rotation strategy is now ${mode}`
      } else if (action === 'test') {
        let key = String(args.key ?? '').trim()
        let baseURL = String(args.baseURL ?? '').trim() || current.baseURL
        if (key === '') {
          const target = String(args.name ?? '').trim()
          const accounts = await accountPool.listAccounts()
          const account = accounts.find((entry) => entry.id === target || entry.alias === target)
          if (account === undefined) throw new Error('cline_pass_accounts action="test" needs key=… or an existing name=…')
          const credentials = await accountPool.getFreshCredential(account.id)
          key = bearerFor(credentials)
          baseURL = credentials.baseURL && credentials.baseURL.trim() !== '' ? credentials.baseURL : baseURL
        }
        const result = await engine.testAccount({ key, baseURL, model })
        ok = result.authorized
        note = result.authorized ? `key authorized in ${result.ms}ms` : `key FAILED: ${firstLine(result.error, 200)}`
      }
      const accounts = await accountPool.listAccounts()
      return {
        ok,
        action,
        note,
        accounts: accounts.map((account) => ({
          id: account.id,
          alias: account.alias,
          isPrimary: account.isPrimary,
          enabled: account.authStatus === undefined || account.authStatus === 'ok',
          ...(account.cooldownUntil === undefined ? {} : { cooldownUntil: Math.round(account.cooldownUntil) }),
          ...(account.authStatus === undefined ? {} : { authStatus: account.authStatus }),
        })),
      }
    },
  })))

  // ── cline_pass_history ────────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_history',
    description: 'Read the in-process request history (newest first): account, upstream that served each call, latency, error. Read-only and free. In memory only, so it starts empty after a restart.',
    parameters: {
      limit: { type: 'integer', description: 'How many rows to return (default 25, max 100).' },
      model: { type: 'string', description: 'Only return rows whose model id contains this text.' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ts: { type: 'integer', required: true },
                model: { type: 'string', required: true },
                provider: { type: 'string', required: true },
                account: { type: 'string', required: true },
                ms: { type: 'integer', required: true },
                ttft: { type: 'integer', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.entries.length === 0) return text('No Cline Pass model calls recorded yet in this process.')
        return text([
          `last ${value.entries.length} of ${value.total} call(s):`,
          ...value.entries.map((entry) => `${entry.ts === 0 ? '-' : new Date(entry.ts).toISOString()} ${entry.model} -> ${entry.provider || '(auto)'} ${entry.ttft > 0 ? `${entry.ttft}ms` : '—'}/${entry.ms}ms account=${entry.account || '-'}${entry.error === '' ? '' : ` error=${entry.error}`}`),
        ].join('\n'))
      },
    },
    async execute(args) {
      const limit = Number.isSafeInteger(args.limit) && (args.limit ?? 0) > 0 ? Math.min(args.limit as number, 100) : 25
      const entries = store.readHistory(limit, args.model ?? '')
      return {
        total: store.historySize(),
        entries: entries.map((entry) => ({
          ts: Math.round(entry.ts),
          model: entry.model,
          provider: entry.provider,
          account: entry.account,
          ms: Math.round(entry.ms),
          ttft: Math.round(entry.ttft),
          error: firstLine(entry.error, 200),
        })),
      }
    },
  })))

  return disposers
}

/** Every id the visibility toggle may act on, including shipped ones. */
function currentModelsForVisibility(settings: { catalogModels: Array<{ id: string }>; hiddenModels: string[] }): string[] {
  const ids = new Set<string>(DEFAULT_MODELS)
  for (const model of settings.catalogModels) ids.add(model.id)
  return [...ids]
}
