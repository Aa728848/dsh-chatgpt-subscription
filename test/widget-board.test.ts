import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LINE_ACCOUNT_STRATEGY_CAPABILITY_ID,
  LINE_ACCOUNT_SWITCH_CAPABILITY_ID,
  LINE_CARD_DATA_SOURCE_ID,
  LINE_REFRESH_CAPABILITY_ID,
  WIDGET_BOARD_PROVIDER,
  widgetFullName,
} from '../src/host/widget-board/line-contracts.ts'
import {
  registerWidgetBoard,
  widgetsDirectory,
  type WidgetBoardCapabilityRegistration,
  type WidgetBoardContext,
  type WidgetBoardDataSourceRegistration,
  type WidgetBoardHandle,
  type WidgetBoardScope,
  type WidgetBoardService,
} from '../src/host/widget-board/provider.ts'

/**
 * The provider, driven through its real registration function against doubles.
 *
 * The design under test is the boundary: what the board is handed (names,
 * versions, directory), what happens when any of that is missing or broken, and
 * that the one card this package ships names registrations this provider really
 * publishes.
 *
 * The two ChatGPT-only cards this provider used to publish are deliberately
 * absent: their shapes, their unit conversion and their capabilities went with
 * the cards that read them, so the cases covering them were deleted rather than
 * rewritten. What is left is what still exists — one `line-card` data source and
 * its three line capabilities — plus the lifecycle rules that outlived both
 * designs.
 */

/** A directory the test owns, so nothing depends on the package layout. */
const TEST_DIRECTORY = path.join(path.sep, 'test-widgets')

/** What one widget-type registration captured. */
interface RegistrationGroup {
  dataSources?: WidgetBoardDataSourceRegistration[]
  capabilities?: WidgetBoardCapabilityRegistration[]
}

/** A fake board plus everything it was handed. */
interface FakeBoard {
  service: WidgetBoardService
  widgetTypes: Array<{ apiVersion: number, provider: string, directory: string }>
  groups: RegistrationGroup[]
  disposed: () => number
  /** Open the gate a `manual` board holds its registration behind. */
  release: () => void
}

/**
 * A board double that records registrations.
 *
 * @param config - apiVersion to report, whether capabilities exist, and whether
 *   `registerWidgetType` should answer late (to exercise a load racing an unload).
 * @returns The board and what it was handed.
 */
function fakeBoard(config: { apiVersion?: unknown, capabilities?: boolean, manual?: boolean } = {}): FakeBoard {
  const widgetTypes: FakeBoard['widgetTypes'] = []
  const groups: RegistrationGroup[] = []
  let disposed = 0
  let openGate: () => void = () => undefined
  const gate = config.manual === true
    ? new Promise<void>((resolve) => { openGate = resolve })
    : undefined
  const registerCapability = () => () => undefined
  const service = {
    apiVersion: config.apiVersion ?? 3,
    registerWidgetType: async (registration: { apiVersion: number, provider: string, directory: string }): Promise<WidgetBoardHandle> => {
      widgetTypes.push(registration)
      const handle: WidgetBoardHandle = {
        provider: registration.provider,
        widgets: [],
        register: (group: RegistrationGroup = {}) => {
          groups.push(group)
          return () => undefined
        },
        dispose: async () => { disposed += 1 },
      }
      if (gate !== undefined) await gate
      return handle
    },
    ...(config.capabilities === false ? {} : { registerCapability }),
  }
  return {
    service: service as unknown as WidgetBoardService,
    widgetTypes,
    groups,
    disposed: () => disposed,
    release: () => openGate(),
  }
}

/** A host context whose `inject` hands over the board (or nothing). */
function fakeContext(service: WidgetBoardService | undefined) {
  const warnings: string[] = []
  const disposers: Array<() => void> = []
  const injected: string[][] = []
  const scope: WidgetBoardScope = {
    get: (name: string) => (name === 'widgetBoard' ? service : undefined),
    logger: { warn: (message: string) => { warnings.push(message) } },
    effect: (callback: () => () => void) => { disposers.push(callback()) },
  }
  const ctx: WidgetBoardContext = {
    inject: (names: string[], callback: (scope: WidgetBoardScope) => void) => {
      injected.push(names)
      callback(scope)
    },
  }
  return { ctx, warnings, disposers, injected }
}

/** Let the fire-and-forget registration settle. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The line registry options a real composition hands over, minus any pool.
 *
 * A registration reads no pool and calls no route, so an empty mapping is
 * enough: what is under test here is the registration, not a card read.
 */
function lineOptions() {
  return { origin: () => 'http://127.0.0.1:3080', pools: {} }
}

/**
 * Register the provider against a fake board.
 *
 * @param board - The board to inject.
 * @param options - Directory override, and whether the composition has a line
 *   registry at all.
 * @returns The fake board, the host context and the disposers it collected.
 */
async function start(
  board: FakeBoard,
  options: { directory?: string, lines?: boolean } = {},
) {
  const host = fakeContext(board.service)
  registerWidgetBoard(host.ctx, {
    ...(options.lines === false ? {} : { lines: lineOptions() }),
    widgetsDirectory: options.directory ?? TEST_DIRECTORY,
  })
  await settled()
  return { ...host, board }
}

/** Every registration a group holds, data sources first. */
function registrationsOf(group: RegistrationGroup | undefined) {
  return [...(group?.dataSources ?? []), ...(group?.capabilities ?? [])]
}

/** The board's own id rule, in the shape a manifest has to satisfy. */
const BOARD_ID = /^[a-z][a-z0-9.-]{1,39}$/

describe('widget board registration', () => {
  it('registers the directory, the line card and its three capabilities', async () => {
    const board = fakeBoard()
    const host = await start(board)
    expect(host.injected).toEqual([['widgetBoard']])
    expect(board.widgetTypes).toEqual([{
      apiVersion: 3,
      provider: WIDGET_BOARD_PROVIDER,
      directory: TEST_DIRECTORY,
    }])
    const group = board.groups[0]
    expect(group?.dataSources?.map((source) => source.id)).toEqual([LINE_CARD_DATA_SOURCE_ID])
    expect(group?.capabilities?.map((capability) => capability.id)).toEqual([
      LINE_REFRESH_CAPABILITY_ID,
      LINE_ACCOUNT_SWITCH_CAPABILITY_ID,
      LINE_ACCOUNT_STRATEGY_CAPABILITY_ID,
    ])
    // One provider name everywhere, and the scoped package id never appears.
    for (const registration of registrationsOf(group)) {
      expect(registration.provider).toBe(WIDGET_BOARD_PROVIDER)
      expect(registration.apiVersion).toBe(3)
      // A manifest writes `<provider>:<id>`, so the id has to survive the
      // board's own grammar on its own.
      expect(registration.id).toMatch(BOARD_ID)
    }
    expect(WIDGET_BOARD_PROVIDER).toMatch(BOARD_ID)
    expect(JSON.stringify(group)).not.toContain('@eddyskywalker')
    expect(host.warnings).toEqual([])
  })

  it('passes the version the board reports through instead of a constant', async () => {
    const board = fakeBoard({ apiVersion: 7 })
    await start(board)
    expect(board.widgetTypes[0]?.apiVersion).toBe(7)
    expect(board.groups[0]?.dataSources?.[0]?.apiVersion).toBe(7)
    expect(board.groups[0]?.capabilities?.[0]?.apiVersion).toBe(7)
  })

  it('declares no permission on any registration', async () => {
    // Nothing here runs a command or reaches a host the caller chose: the data
    // source reads this host's own status routes over loopback, and the
    // capabilities write only their own line's pool document.
    const board = fakeBoard()
    await start(board)
    for (const registration of registrationsOf(board.groups[0])) {
      expect(Object.hasOwn(registration, 'permission')).toBe(false)
    }
  })

  it('skips a board whose apiVersion is not a usable number', async () => {
    for (const apiVersion of [1, 0, Number.NaN, 'three']) {
      const board = fakeBoard({ apiVersion })
      const host = await start(board)
      expect(board.widgetTypes).toEqual([])
      expect(host.warnings).toHaveLength(1)
      expect(host.warnings[0]).toContain('apiVersion')
    }
  })

  it('does nothing at all when the host has no board', async () => {
    const host = fakeContext(undefined)
    expect(() => registerWidgetBoard(host.ctx, {
      lines: lineOptions(),
      widgetsDirectory: TEST_DIRECTORY,
    })).not.toThrow()
    await settled()
    expect(host.warnings).toEqual([])
    expect(host.disposers).toEqual([])
  })

  it('registers no capabilities on a board without them', async () => {
    const board = fakeBoard({ apiVersion: 2, capabilities: false })
    await start(board)
    const group = board.groups[0]
    expect(group?.dataSources).toHaveLength(1)
    expect(group?.capabilities).toBeUndefined()
  })

  it('registers nothing at all when the composition hands no line registry', async () => {
    // The line registry is the whole contribution: without it there is no
    // ChatGPT-only fallback to fall back to.
    const board = fakeBoard()
    const host = await start(board, { lines: false })
    expect(board.widgetTypes).toHaveLength(1)
    expect(board.groups[0]?.dataSources).toEqual([])
    expect(board.groups[0]?.capabilities).toEqual([])
    expect(host.warnings).toEqual([])
  })

  it('disposes the handle when the plugin unloads, and never leaves a late one behind', async () => {
    const board = fakeBoard()
    const host = await start(board)
    expect(host.disposers).toHaveLength(1)
    for (const dispose of host.disposers) dispose()
    await settled()
    expect(board.disposed()).toBe(1)

    // Unloaded while the directory was still being read: the registration that
    // lands afterwards is handed back instead of published.
    const late = fakeBoard({ manual: true })
    const pending = await start(late)
    for (const dispose of pending.disposers) dispose()
    late.release()
    await settled()
    expect(late.disposed()).toBe(1)
    expect(late.groups).toEqual([])
  })

  it('warns, without failing the load, when the directory cannot be registered', async () => {
    const board = fakeBoard()
    board.service.registerWidgetType = async () => { throw new Error('directory unreadable') }
    const host = await start(board)
    expect(host.warnings).toHaveLength(1)
    expect(host.warnings[0]).toContain('directory unreadable')
  })

  it('resolves the shipped widget directory from the loaded module', () => {
    // From `src/` in a test run and from `lib/` in the built package: both walk up
    // to the package.json that names this package.
    expect(widgetsDirectory()).toBe(path.resolve(__dirname, '..', 'widgets'))
  })
})

/**
 * What one shipped card's manifest states, as read from this package.
 *
 * Only the two fields that have to agree with a registration are modelled: the
 * data source the card reads and the capabilities it calls.
 */
interface CardManifest {
  file: string
  source: unknown
  capabilities: unknown
}

/**
 * Every card this package ships, in directory order.
 *
 * @returns One entry per `widgets/<id>/widget.json`.
 */
function shippedCards(): CardManifest[] {
  const root = path.resolve(__dirname, '..', 'widgets')
  const ids = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  return ids.map((id) => {
    const file = path.join(root, id, 'widget.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      source?: unknown
      capabilities?: unknown
    }
    return { file, source: manifest.source, capabilities: manifest.capabilities }
  })
}

describe('shipped card manifests name registrations this provider publishes', () => {
  it('spells every source and capability exactly as the registration id does', async () => {
    // A manifest writes `<provider>:<id>`, and the board resolves that string
    // literally: a card naming an id this provider never registered silently
    // never gets data. So the names are read off a REAL registration rather than
    // off the constants, and compared to the manifests one by one.
    const board = fakeBoard()
    await start(board)
    const group = board.groups[0]
    const registeredSources = new Set((group?.dataSources ?? []).map((source) => widgetFullName(source.id)))
    const registeredCapabilities = new Set(
      (group?.capabilities ?? []).map((capability) => widgetFullName(capability.id)),
    )
    expect(registeredSources.size).toBeGreaterThan(0)
    expect(registeredCapabilities.size).toBeGreaterThan(0)

    const cards = shippedCards()
    // A loop over no cards would pass vacuously, and an empty `widgets/` folder is
    // exactly the failure that must not pass.
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(registeredSources.has(String(card.source)), `${card.file}: source ${String(card.source)}`).toBe(true)
      expect(Array.isArray(card.capabilities), `${card.file}: capabilities is not an array`).toBe(true)
      for (const capability of card.capabilities as unknown[]) {
        expect(
          registeredCapabilities.has(String(capability)),
          `${card.file}: capability ${String(capability)}`,
        ).toBe(true)
      }
    }
  })
})
