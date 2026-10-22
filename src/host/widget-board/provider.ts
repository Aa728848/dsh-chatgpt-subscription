/**
 * The `widgetBoard` provider: this plugin's board contribution.
 *
 * What it publishes (all under one handle, so unloading this plugin takes all
 * of it with it):
 *
 * - one widget-type directory — the `widgets` folder that ships in this package;
 * - one data source, `line-card`, which answers one card per subscription line;
 * - three capabilities: force one line's quota read, pin one of its pooled
 *   accounts, and change that line's rotation strategy.
 *
 * The two ChatGPT-only cards this provider used to publish (one for quota, one
 * for the account pool) are gone: `widgets/line-flip` replaced both with a single
 * card that names its line in `props.line`, so the old per-subject data sources,
 * their shapes and their unit conversion were deleted rather than left unused.
 *
 * The service is optional. A host without a board never reaches the inject
 * callback at all, and everything below is sized to make that true even when
 * the board IS present: nothing here may fail the plugin's load, so the
 * registration runs off the load path and every failure is a warn.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccountRotationStrategy } from '../../shared/account-pool-contracts.ts'
import {
  LINE_ACCOUNT_STRATEGY_CAPABILITY_ID,
  LINE_ACCOUNT_STRATEGY_INPUT_SCHEMA,
  LINE_ACCOUNT_SWITCH_CAPABILITY_ID,
  LINE_ACCOUNT_SWITCH_INPUT_SCHEMA,
  LINE_CARD_DATA_SOURCE_ID,
  LINE_CARD_SCHEMA,
  LINE_REFRESH_CAPABILITY_ID,
  LINE_REFRESH_INPUT_SCHEMA,
  WIDGET_BOARD_PROVIDER,
  type LineCardData,
} from './line-contracts.ts'
import {
  createLineRegistry,
  lineOfProps,
  type LineAccountQuotaClient,
  type LineAccountSource,
  type LineRegistry,
} from './line-registry.ts'

/**
 * The package name the widget directory is looked up by.
 *
 * Deliberately the SCOPED id, unlike {@link WIDGET_BOARD_PROVIDER}: this string
 * never reaches a manifest, it only identifies which `package.json` found by
 * walking up from this file is this package's own.
 */
const PACKAGE_NAME = '@eddyskywalker/dsh-chatgpt-subscription'

/** How many directories to climb while looking for this package's root. */
const MAX_ROOT_WALK = 8

/**
 * Subdirectory of this package that holds the widget types.
 *
 * The board reads every child directory of it as one widget, so it ships as
 * part of the package (`files` in package.json) rather than being generated.
 */
const WIDGET_DIRECTORY_NAME = 'widgets'

/** The card a data source or a capability is called for. */
export interface WidgetBoardInstance {
  id: string
  widget: string
  props: Record<string, unknown>
}

/** A data source registration, as this provider fills it in. */
export interface WidgetBoardDataSourceRegistration {
  apiVersion: number
  provider: string
  id: string
  read(instance: WidgetBoardInstance): unknown | Promise<unknown>
}

/** A capability registration, as this provider fills it in. */
export interface WidgetBoardCapabilityRegistration {
  apiVersion: number
  provider: string
  id: string
  title?: { zh: string; en: string }
  description?: { zh: string; en: string }
  input?: Record<string, unknown>
  output?: Record<string, unknown>
  call(instance: WidgetBoardInstance, args: unknown, signal: AbortSignal): unknown | Promise<unknown>
}

/** The lifecycle handle one widget-type registration answers with. */
export interface WidgetBoardHandle {
  readonly provider: string
  readonly widgets: readonly string[]
  register(registrations?: {
    dataSources?: WidgetBoardDataSourceRegistration[]
    capabilities?: WidgetBoardCapabilityRegistration[]
  }): () => void
  dispose(): Promise<void>
}

/** The `widgetBoard` service, as this module uses it. */
export interface WidgetBoardService {
  readonly apiVersion: number
  registerWidgetType(registration: {
    apiVersion: number
    provider: string
    directory: string
  }): Promise<WidgetBoardHandle>
  /**
   * Present from the board generation that introduced capabilities.
   *
   * Probed, never assumed: an older board publishes no such method, and this
   * provider then registers its data sources alone instead of failing.
   */
  registerCapability?(registration: WidgetBoardCapabilityRegistration): () => void
}

/** The scoped context an inject callback receives. */
export interface WidgetBoardScope {
  get(name: string): unknown
  logger: { warn(message: string): void }
  effect(callback: () => () => void, label?: string): void
}

/**
 * The host context, narrowed to what this module touches.
 *
 * A structural subset of the Cordis `Context`, so the caller casts once at the
 * wiring site and a test can drive the real registration function with a
 * plain object.
 */
export interface WidgetBoardContext {
  inject(names: string[], callback: (scope: WidgetBoardScope) => void): void
}

/**
 * The line registry this provider publishes when the composition hands one over.
 *
 * Deliberately a plain bag of already-resolved services rather than the pools
 * themselves: the mapping's key is a line id the board also knows, its value is
 * whatever that line's pool object is, and this module never learns which class
 * it is talking to.
 */
export interface WidgetBoardLineOptions {
  /**
   * This host's own origin, resolved per read.
   *
   * A thunk rather than a string because the web server may not have bound a
   * port yet when this provider registers, and a value captured then would be a
   * guess that outlives the fact.
   */
  origin(): string
  /** Line id → its pool. A line with no entry is reported as not installed. */
  pools: Readonly<Record<string, LineAccountSource | undefined>>
  /** Test seam: the HTTP client the loopback reads use. */
  fetchFn?: typeof fetch
  /** Test seam: the whole-read budget in milliseconds. */
  timeoutMs?: number
  /**
   * Line id → that line's quota client, for the lines that read a quota PER
   * ACCOUNT (see `LINE_ACCOUNT_QUOTA_READERS` in the registry).
   *
   * Passed through untouched: the composition holds these clients, this module
   * never learns which line they belong to, and a line omitted here is a line
   * that keeps the pool's own single-account snapshot.
   */
  accountQuotaClients?: Readonly<Record<string, LineAccountQuotaClient | undefined>>
}

/** What {@link registerWidgetBoard} is handed. */
export interface WidgetBoardProviderOptions {
  /**
   * The per-line registry, when the composition has one.
   *
   * Absent leaves this provider with nothing to register at all — no
   * `line-card` data source and no line capabilities — which is exactly what a
   * caller that has not wired the line pools wants. There is no ChatGPT-only
   * fallback any more: one card per line is the whole contribution.
   */
  lines?: WidgetBoardLineOptions
  /** Test seam: overrides the widget directory found from `import.meta.url`. */
  widgetsDirectory?: string
}

/**
 * Register this plugin's board contribution, if the host has a board.
 *
 * @param ctx - The host context; only `inject` is used.
 * @param options - The line registry to publish through, and the widget directory override.
 */
export function registerWidgetBoard(ctx: WidgetBoardContext, options: WidgetBoardProviderOptions): void {
  ctx.inject(['widgetBoard'], (scope) => {
    const service = scope.get('widgetBoard') as WidgetBoardService | undefined
    if (service === undefined || service === null) return
    // Read off the service, never a constant: the board accepts exactly ITS own
    // version, so this plugin can only pass through whatever it was handed.
    const apiVersion = service.apiVersion
    if (typeof apiVersion !== 'number' || !Number.isFinite(apiVersion) || apiVersion < 2) {
      scope.logger.warn(
        `[dsh-chatgpt-subscription] widget board provider skipped: the board reports apiVersion ${String(apiVersion)}, which this provider cannot serve (it needs a number >= 2).`,
      )
      return
    }
    if (typeof service.registerWidgetType !== 'function') {
      scope.logger.warn('[dsh-chatgpt-subscription] widget board provider skipped: the board service has no registerWidgetType.')
      return
    }
    scope.effect(() => {
      // Everything below is registered under ONE handle: dropping the handle is
      // what stops this provider leaving data sources and capabilities behind
      // that point at a plugin which is no longer loaded.
      let closed = false
      let handle: WidgetBoardHandle | undefined
      // Built once per registration: it holds no state of its own beyond the
      // injected mapping, so one instance serves every card and every action,
      // and dropping the handle is enough to stop it being reachable.
      const lines = options.lines === undefined ? undefined : createLineRegistry(options.lines)
      const publish = async (): Promise<void> => {
        const directory = options.widgetsDirectory ?? widgetsDirectory()
        if (directory === undefined) {
          scope.logger.warn(
            '[dsh-chatgpt-subscription] widget board provider skipped: this package\'s own package.json could not be found from '
            + 'the loaded module, so the widget directory is unknown.',
          )
          return
        }
        const registered = await service.registerWidgetType({
          apiVersion,
          provider: WIDGET_BOARD_PROVIDER,
          directory,
        })
        if (closed) {
          // Unloaded while the directory was being read: hand the registration
          // straight back instead of publishing into a plugin that is gone.
          await registered.dispose().catch(() => undefined)
          return
        }
        handle = registered
        // The handle owns everything registered through it, so its own
        // disposer is not kept separately: `handle.dispose()` releases the
        // directory, the data sources and the capabilities together.
        registered.register({
          dataSources: lineDataSources(apiVersion, lines),
          // A board from before capabilities reports no `registerCapability`;
          // registering them anyway would make that older board reject the
          // whole batch and cost the data sources too.
          ...(typeof service.registerCapability === 'function'
            ? { capabilities: lineCapabilities(apiVersion, lines) }
            : {}),
        })
      }
      void publish().catch((error: unknown) => {
        scope.logger.warn(
          `[dsh-chatgpt-subscription] widget board registration failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      return () => {
        closed = true
        const current = handle
        handle = undefined
        if (current === undefined) return
        void current.dispose().catch(() => undefined)
      }
    }, 'dsh-chatgpt-subscription: widget board provider')
  })
}

/**
 * This package's widget directory, resolved from the loaded module.
 *
 * `import.meta.url` points at `lib/index.js` in a built package and at a source
 * file under `src/` in a test run, so the root is found by walking up to the
 * `package.json` that names THIS package rather than by assuming a depth.
 *
 * @returns The absolute directory, or undefined when no such manifest was found.
 */
export function widgetsDirectory(): string | undefined {
  const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)))
  return root === undefined ? undefined : path.join(root, WIDGET_DIRECTORY_NAME)
}

/**
 * Walk up from a directory to the package root of this plugin.
 *
 * @param start - Directory to start from.
 * @returns The directory holding this package's `package.json`, or undefined.
 */
function findPackageRoot(start: string): string | undefined {
  let directory = start
  for (let depth = 0; depth < MAX_ROOT_WALK; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as { name?: unknown }
      if (manifest.name === PACKAGE_NAME) return directory
    } catch {
      // No manifest here, or one this process cannot read: keep climbing.
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * The three rotation strategies every line pool accepts, in the pool own
 * vocabulary.
 *
 * The registry re-checks the same list inside its own changeStrategy; this copy
 * is what lets the capability refuse a bad argument before any pool is touched,
 * naming the mistake the way the other capability arguments do.
 */
const ROTATION_STRATEGIES: readonly AccountRotationStrategy[] = ['sequential', 'round-robin', 'sticky']

/**
 * The `accountId` argument, or a refusal.
 *
 * @param args - Capability arguments.
 * @returns The account id.
 */
function readAccountId(args: unknown): string {
  const record = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
  const accountId = record.accountId
  if (typeof accountId !== 'string' || accountId.trim() === '') {
    throw new Error('切换账号需要 accountId 参数。 (Switching accounts needs a non-empty "accountId" argument.)')
  }
  return accountId
}

/**
 * The `strategy` argument, or a refusal.
 *
 * @param args - Capability arguments.
 * @returns The strategy.
 */
function readStrategy(args: unknown): AccountRotationStrategy {
  const record = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
  const strategy = record.strategy
  const match = ROTATION_STRATEGIES.find((candidate) => candidate === strategy)
  if (match === undefined) {
    throw new Error(
      `轮换策略只能是 ${ROTATION_STRATEGIES.join(' / ')} 之一，收到的不是其中之一。 `
      + `(The rotation strategy must be one of ${ROTATION_STRATEGIES.join(', ')}.)`,
    )
  }
  return match
}

/**
 * The `line-card` data source, when a line registry was handed over.
 *
 * This is the whole data side of the board contribution: one source, read per
 * card, with each card naming its own line. A composition with no registry
 * registers nothing here rather than falling back to a ChatGPT-only source.
 *
 * @param apiVersion - The board's own version, passed through verbatim.
 * @param lines - The registry, when the composition has one.
 * @returns The registrations; empty without a registry.
 */
function lineDataSources(apiVersion: number, lines: LineRegistry | undefined): WidgetBoardDataSourceRegistration[] {
  if (lines === undefined) return []
  return [{
    apiVersion,
    provider: WIDGET_BOARD_PROVIDER,
    id: LINE_CARD_DATA_SOURCE_ID,
    // Each card states its own line, so one data source serves every line's
    // card without the board having to know how many lines exist.
    read: (instance) => lines.read(lineOfProps(instance.props)),
  }]
}

/**
 * The three line capabilities, when a line registry was handed over.
 *
 * Like the data source they declare no `permission`: they force one line's own
 * quota read or write one line's own pool document, both of which the user is
 * already looking at on the card they clicked.
 *
 * @param apiVersion - The board's own version, passed through verbatim.
 * @param lines - The registry, when the composition has one.
 * @returns The registrations; empty without a registry.
 */
function lineCapabilities(apiVersion: number, lines: LineRegistry | undefined): WidgetBoardCapabilityRegistration[] {
  if (lines === undefined) return []
  return [
    {
      apiVersion,
      provider: WIDGET_BOARD_PROVIDER,
      id: LINE_REFRESH_CAPABILITY_ID,
      title: { zh: '刷新该线路额度', en: 'Refresh this line quota' },
      description: {
        zh: '先让这条线路自己向上游读一次额度，再把读到的结果作为整张卡交回。',
        en: 'Ask the line to read its quota upstream, then answer with the refreshed card.',
      },
      input: LINE_REFRESH_INPUT_SCHEMA,
      output: LINE_CARD_SCHEMA,
      call: (_instance, args, signal) => withLine(lines, args, (line) => lines.refresh(line, signal)),
    },
    {
      apiVersion,
      provider: WIDGET_BOARD_PROVIDER,
      id: LINE_ACCOUNT_SWITCH_CAPABILITY_ID,
      title: { zh: '切换线路账号', en: 'Switch line account' },
      description: {
        zh: '把这条线路号池里的某个账号设为主账号，之后的下一次请求就由它来发。',
        en: 'Pin one account of this line as the primary; the next request is spent on it.',
      },
      input: LINE_ACCOUNT_SWITCH_INPUT_SCHEMA,
      output: LINE_CARD_SCHEMA,
      call: (_instance, args, signal) => withLine(lines, args, (line) => lines.switchAccount(line, readAccountId(args), signal)),
    },
    {
      apiVersion,
      provider: WIDGET_BOARD_PROVIDER,
      id: LINE_ACCOUNT_STRATEGY_CAPABILITY_ID,
      title: { zh: '线路轮换策略', en: 'Line rotation strategy' },
      description: {
        zh: '改这条线路号池的选择策略：顺序、轮询或粘住当前账号。',
        en: 'Change how this line s pool picks its next account: sequential, round-robin or sticky.',
      },
      input: LINE_ACCOUNT_STRATEGY_INPUT_SCHEMA,
      output: LINE_CARD_SCHEMA,
      call: (_instance, args, signal) => withLine(lines, args, (line) => lines.changeStrategy(line, readStrategy(args), signal)),
    },
  ]
}

/**
 * The `line` argument of one line capability.
 *
 * @param args - Capability arguments, already schema-checked by the board.
 * @returns The line id.
 */
function readLine(args: unknown): string {
  const record = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
  const line = record.line
  if (typeof line !== 'string' || line.trim() === '') {
    throw new Error('这条能力需要 line 参数，指明作用在哪条线路上。 (This capability needs a non-empty \"line\" argument.)')
  }
  return line.trim()
}

/**
 * Run one line action, resolving its `line` argument first.
 *
 * The check runs before the action so an unknown line fails on the argument
 * rather than halfway through a write, and so every capability reports the same
 * sentence for the same mistake.
 *
 * @param lines - The registry.
 * @param args - Capability arguments.
 * @param run - The action, given the resolved line id.
 * @returns The refreshed card.
 */
async function withLine(
  lines: LineRegistry,
  args: unknown,
  run: (line: string) => Promise<LineCardData>,
): Promise<LineCardData> {
  const line = readLine(args)
  if (!lines.ids().includes(line)) {
    throw new Error(
      '未知线路「' + line + '」：已知的是 ' + lines.ids().join(' / ') + '。'
      + ' (Unknown line; known lines: ' + lines.ids().join(', ') + '.)',
    )
  }
  return await run(line)
}
