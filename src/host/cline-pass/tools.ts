/**
 * The model-facing `cline_pass_*` management tools.
 *
 * They manage accounts, model visibility and diagnostics. Registration is
 * optional and read at startup (see `exposeTools`) so a conversation that never
 * manages the route does not carry these schemas in every request's tool list.
 *
 * @module dsh-chatgpt-subscription/cline-pass-tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ClinePassAccountPool } from './account-pool.ts'
import type { ClinePassEngine } from './engine.ts'
import type { ClinePassStore } from './store.ts'
import type { ClinePassModelSettingsStore } from './token-store.ts'
import { bearerFor, listedClinePassCatalogModels } from './token-store.ts'
import { DEFAULT_MODELS } from './types.ts'
import type { ClinePassWebStatus } from '../../shared/cline-pass-contracts.ts'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function firstLine(value: unknown, max = 200): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

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

const MODEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    displayName: { type: 'string', required: true },
    pipeline: { type: 'string', required: true },
    hidden: { type: 'boolean', required: true },
    lastProvider: { type: 'string', required: true },
    lastMs: { type: 'integer', required: true },
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
    hidden: !entry.enabled,
    lastProvider: entry.lastProvider,
    lastMs: Math.round(entry.lastMs),
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

  // ── cline_pass_status ─────────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_status',
    description: 'Report the Cline Pass provider state: route, accounts, account mode and model count. Read-only and free. Check this first when a Cline Pass model fails.',
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
        },
      },
      render: (_args, value) => text([
        `${value.displayName} provider "cline-pass" @ ${value.baseURL}`,
        `route registered=${value.routeRegistered}`,
        `accountMode=${value.accountMode}`,
        `accounts (${value.accounts.length}):`,
        ...value.accounts.map((account) => `  ${account.alias} (${account.id})${account.enabled ? '' : ' (disabled)'}${account.authStatus ? ` [${account.authStatus}]` : ''}`),
        `models: known=${value.knownModels}`,
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
      }
    },
  })))

  // ── cline_pass_models ─────────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_models',
    description: 'List Cline Pass models with visibility and observed response routing. Pass `model` to filter by substring, `refresh: true` to rescan the official model list, `model` + `visible` to show/hide one model, or `mode` to change them all. Free unless `refresh` is set.',
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
          return [
            `${model.id}  pipeline=${model.pipeline || 'unknown'}${model.hidden ? ' (hidden from pickers)' : ''}`,
            model.lastProvider === '' ? '' : `  last=${model.lastProvider} (${model.lastMs}ms)`,
          ].filter((line) => line !== '').join('\n')
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
            origin: 'official',
            ...(published.name === undefined ? {} : { name: published.name }),
            ...(published.contextWindow === undefined ? {} : { contextWindow: published.contextWindow }),
            ...(published.maxTokens === undefined ? {} : { maxTokens: published.maxTokens }),
            ...(published.reasoning === undefined ? {} : { reasoning: published.reasoning }),
            ...(published.input === undefined && published.inputModalities === undefined ? {} : { input: published.input ?? published.inputModalities }),
            ...(published.efforts === undefined ? {} : { efforts: published.efforts }),
          })
        }
        await settings.storeCatalog(merged)
        const gateway = await engine.gatewayCatalog().catch(() => ({ ids: [], models: {} }))
        store.setCatalog({
          ids: [...new Set([...scan.models, ...gateway.ids])],
          sources: [...scan.sources, ...(gateway.ids.length > 0 ? ['gateway'] : [])],
          // Gateway metadata fills the marketplace ids the official scan does not
          // publish; the official scan wins where both describe the same id.
          models: { ...gateway.models, ...scan.catalog } as Record<string, unknown>,
        })
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
        // The catalog the user can pick from, not the search index: `ids` now
        // also holds the whole gateway catalog, and reporting its size here made
        // this surface disagree with the status route (and claim ~492 "official"
        // models).
        catalogCount: listedClinePassCatalogModels(await settings.read()).length,
        catalogSources: catalog.sources,
        catalogFetchedAt: Math.round(catalog.fetchedAt),
        added,
      }
    },
  })))

  // ── cline_pass_test ───────────────────────────────────────────────────────

  disposers.push(ctx.tools.register(defineTool({
    name: 'cline_pass_test',
    description: 'Send one small, automatically routed request and report which upstream served it. No client-side routing fields are sent.',
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
          actual: { type: 'string', required: true },
          pipeline: { type: 'string', required: true },
          account: { type: 'string', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => text([
        value.ok ? `test ${value.model}: ok in ${value.ms}ms via ${value.actual || '(unknown)'}` : `test ${value.model}: FAILED — ${value.error}`,
        ...value.warnings.map((warning) => `⚠ ${warning}`),
      ].join('\n')),
    },
    async execute(args, exec) {
      const model = String(args.model).trim()
      const result = await engine.test(model, { signal: exec.signal })
      return {
        ok: result.ok,
        model,
        error: firstLine(result.error, 400),
        ms: Math.round(result.ms),
        actual: result.actual,
        pipeline: result.pipeline,
        account: result.account,
        warnings: result.warnings,
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
function currentModelsForVisibility(settings: { catalogModels: Array<{ id: string; origin?: 'official' | 'custom' | 'gateway' }>; hiddenModels: string[] }): string[] {
  const ids = new Set<string>(DEFAULT_MODELS)
  for (const model of listedClinePassCatalogModels(settings)) ids.add(model.id)
  return [...ids]
}
