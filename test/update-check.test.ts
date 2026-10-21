import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { OAuthService } from '../src/host/oauth-service.ts'
import { MemoryTokenStore } from '../src/host/token-store.ts'
import { UsageService } from '../src/host/usage-service.ts'
import { registerRoutes } from '../src/host/routes.ts'
import type { SubscriptionPreferenceStore } from '../src/host/preferences.ts'
import { compareVersions, installKindFromPath, readOwnManifest, registerUpdateRoutes } from '../src/host/update-check.ts'
import type { OwnManifest, UpdateChangeResult, UpdatePluginManager, UpdateRouteOptions } from '../src/host/update-check.ts'
import { UPDATE_APPLY_PATH, UPDATE_CHECK_PATH, UPDATE_PACKAGE_NAME } from '../src/shared/update-contracts.ts'
import type { UpdateApplyDto, UpdateCheckDto, UpdateFailureDto } from '../src/shared/update-contracts.ts'

/**
 * The update routes against a real HTTP server, with the registry and the plugin
 * manager both stubbed. Nothing here reaches the network: the fetch is injected
 * exactly the way `src/index.ts` injects the proxy-aware one, so the tests pin
 * the route's own behavior rather than the machine's connectivity.
 */
const servers: http.Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })))
})

interface Route { kind: string; path: string; handler: http.RequestListener }

/** A copy installed from the registry: under `node_modules`, with a registry range recorded. */
const REGISTRY_INSTALL: OwnManifest = { version: '0.34.0', root: '/home/u/.dsh/profiles/web/node_modules/@eddyskywalker/dsh-chatgpt-subscription' }

/** A copy linked from a developer's checkout: no `node_modules` segment anywhere. */
const LINKED_INSTALL: OwnManifest = { version: '0.34.0', root: '/home/u/src/dsh-chatgpt-subscription' }

/** A plugin manager whose bundle list says how the installed copy was declared. */
function managerOf(source: string | undefined, installed: string | null): UpdatePluginManager & { installs: string[] } {
  const installs: string[] = []
  return {
    installs,
    listBundles: async () => [{ name: UPDATE_PACKAGE_NAME, ...(source === undefined ? {} : { source }) }],
    installBundle: async (spec) => {
      installs.push(spec)
      return { application: 'restart-required', version: installed ?? undefined }
    },
  }
}

/** One manager call's answer: a settled result, or an error thrown out of the call. */
type Answer = UpdateChangeResult | Error

/**
 * A plugin manager that answers from a script and records the calls in order.
 *
 * The scripts are the whole point: the update has four distinct endings that
 * differ only in what each call answers, and only the call order can prove that
 * a Host which accepts the direct install never loses its working copy.
 */
function scriptedManager(options: { install: Answer[]; remove?: Answer; source?: string }) {
  const installs: string[] = []
  const removes: string[] = []
  const removal = options.remove
  return {
    installs,
    removes,
    listBundles: async () => [{ name: UPDATE_PACKAGE_NAME, source: options.source ?? `${UPDATE_PACKAGE_NAME}@^0.34.0` }],
    installBundle: async (spec: string): Promise<UpdateChangeResult> => {
      installs.push(spec)
      const answer = options.install[installs.length - 1]
      if (answer === undefined) throw new Error(`unscripted install ${String(installs.length)}: ${spec}`)
      if (answer instanceof Error) throw answer
      return answer
    },
    // Omitted entirely, the manager looks like an older Host with no removal at all.
    ...(removal === undefined ? {} : {
      removeBundle: async (name: string): Promise<UpdateChangeResult> => {
        removes.push(name)
        const answer: Answer = removal
        if (answer instanceof Error) throw answer
        return answer
      },
    }),
  }
}

/** What a Host answers when it reloaded the replaced bundle live. */
const APPLIED: UpdateChangeResult = { application: 'applied', version: '0.35.0' }

/** The refusal an HMR profile gives an installation over a package it already has. */
const ALREADY_INSTALLED: UpdateChangeResult = {
  application: 'failed', changed: false, error: { code: 'already-installed' },
}

/** A pnpm-level failure, with the diagnostic that has to survive to the card. */
const INSTALL_BROKEN: UpdateChangeResult = {
  application: 'failed', changed: false, error: { code: 'operation-error', diagnostic: 'pnpm: ENOSPC' },
}

/** A removal that succeeded: the profile lost the dependency. */
const REMOVED: UpdateChangeResult = { application: 'applied', changed: true }

/** POST the apply route and read whichever shape it answered. */
async function postApply(origin: string): Promise<
  { status: number; value: UpdateApplyDto; error?: undefined } | { status: number; value?: undefined; error: UpdateFailureDto['error'] }
> {
  const response = await fetch(`${origin}${UPDATE_APPLY_PATH}`, { method: 'POST' })
  const body = await response.json() as { ok: true; value: UpdateApplyDto } | UpdateFailureDto
  return body.ok ? { status: response.status, value: body.value } : { status: response.status, error: body.error }
}

/** A fetch that answers the registry document, or fails the way an offline machine does. */
function registryFetch(version: string | null): typeof fetch {
  return (async (input: string | URL | Request) => {
    // Only the registry document is ever requested by these routes.
    if (!String(input).includes('registry.npmjs.org')) throw new Error(`unexpected fetch ${String(input)}`)
    if (version === null) throw new TypeError('fetch failed')
    return Response.json({ version })
  }) as typeof fetch
}

async function mount(options: UpdateRouteOptions & { routes: Route[]; withProviderRoutes?: boolean }): Promise<string> {
  const settle = options.readManifest ?? (async () => REGISTRY_INSTALL)
  registerUpdateRoutes(
    { webServer: { register(route: Route) { options.routes.push(route); return () => undefined } } } as never,
    {
      fetchFn: options.fetchFn ?? registryFetch('0.99.0'),
      readManifest: settle,
      ...(options.manager === undefined ? {} : { manager: options.manager }),
    },
  )
  // The harness's documented order, and the one the two new exact routes depend
  // on: the exact table first, then the longest prefix. `withProviderRoutes`
  // registers the real provider prefix handler beside them, so the case where
  // that handler would otherwise swallow these paths is exercised for real.
  const dispatch = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const exact = options.routes.find((entry) => entry.kind === 'exact' && entry.path === pathname)
    if (exact !== undefined) {
      void exact.handler(request, response)
      return
    }
    const prefix = options.routes
      .filter((entry) => entry.kind === 'prefix' && (pathname === entry.path || pathname.startsWith(`${entry.path}/`)))
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (prefix !== undefined) {
      void prefix.handler(request, response)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('Not found')
  }
  const server = http.createServer(dispatch)
  servers.push(server)
  return await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no address')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

/** Read one check answer as the DTO. */
async function check(origin: string): Promise<UpdateCheckDto> {
  const response = await fetch(`${origin}${UPDATE_CHECK_PATH}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = await response.json() as { ok: true; value: UpdateCheckDto }
  expect(body.ok).toBe(true)
  return body.value
}

describe('update check without a plugin manager', () => {
  it('still reports both versions and refuses the install with plugin-manager-missing', async () => {
    const routes: Route[] = []
    const origin = await mount({ routes, manager: () => null })
    const value = await check(origin)
    // The version check never needed the manager, so it keeps working.
    expect(value.current).toBe('0.34.0')
    expect(value.latest).toBe('0.99.0')
    expect(value.updateAvailable).toBe(true)
    expect(value.canApply).toBe(false)
    expect(value.reason).toBe('plugin-manager-missing')
    expect(value.command).toBe(`dsh plugin add ${UPDATE_PACKAGE_NAME}@latest`)

    const applied = await fetch(`${origin}${UPDATE_APPLY_PATH}`, { method: 'POST' })
    expect(applied.status).toBe(409)
    const body = await applied.json() as { ok: false; error: { code: string; message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('plugin-manager-missing')
    // The refusal names the way out rather than only the refusal.
    expect(body.error.message).toContain(`dsh plugin add ${UPDATE_PACKAGE_NAME}@latest`)
  })
})

describe('update check on a local development link', () => {
  it('reports the newer version, never offers the install, and answers the apply with development-install', async () => {
    const routes: Route[] = []
    // The manager is present and its bundle row names a `link:` dependency, so the
    // refusal comes from the authoritative fact rather than from the path guess.
    const manager = managerOf('link:/home/u/src/dsh-chatgpt-subscription', null)
    const origin = await mount({
      routes,
      readManifest: async () => LINKED_INSTALL,
      manager: () => manager,
    })
    const value = await check(origin)
    expect(value.installKind).toBe('link')
    expect(value.updateAvailable).toBe(true)
    expect(value.canApply).toBe(false)
    expect(value.reason).toBe('development-install')
    // Detection still happened: the newer version is reported even though it
    // cannot be installed here.
    expect(value.latest).toBe('0.99.0')

    const applied = await fetch(`${origin}${UPDATE_APPLY_PATH}`, { method: 'POST' })
    expect(applied.status).toBe(409)
    expect((await applied.json() as { error: { code: string } }).error.code).toBe('development-install')
    // Nothing was installed over the developer's checkout.
    expect(manager.installs).toEqual([])
  })

  it('recognises the link from the path alone when no manager can say', async () => {
    const routes: Route[] = []
    const origin = await mount({ routes, readManifest: async () => LINKED_INSTALL, manager: () => ({ installBundle: async () => ({}) }) })
    const value = await check(origin)
    expect(value.installKind).toBe('link')
    expect(value.reason).toBe('development-install')
  })
})

describe('update check against an unreachable registry', () => {
  it('answers registry-unreachable instead of a 500', async () => {
    const routes: Route[] = []
    const origin = await mount({ routes, fetchFn: registryFetch(null) })
    const value = await check(origin)
    expect(value.latest).toBeNull()
    expect(value.updateAvailable).toBe(false)
    expect(value.canApply).toBe(false)
    expect(value.reason).toBe('registry-unreachable')
    // The running version is still known: only the upstream question failed.
    expect(value.current).toBe('0.34.0')
  })
})

describe('update check on a normal registry install', () => {
  it('computes updateAvailable from a fixed pair and installs the server-owned spec', async () => {
    const routes: Route[] = []
    const manager = managerOf(`${UPDATE_PACKAGE_NAME}@^0.34.0`, '0.35.0')
    const origin = await mount({ routes, manager: () => manager })
    const value = await check(origin)
    expect(value.installKind).toBe('registry')
    expect(value.updateAvailable).toBe(true)
    expect(value.canApply).toBe(true)
    expect(value.reason).toBeUndefined()

    const applied = await fetch(`${origin}${UPDATE_APPLY_PATH}`, { method: 'POST' })
    expect(applied.status).toBe(200)
    const body = await applied.json() as { ok: true; value: UpdateApplyDto }
    expect(body.value).toEqual({ installed: '0.35.0', restartRequired: true, removedFirst: false })
    // The spec is the module constant, never something the client sent.
    expect(manager.installs).toEqual([`${UPDATE_PACKAGE_NAME}@latest`])
  })

  it('reports no update when the running version is the published one', async () => {
    const routes: Route[] = []
    const origin = await mount({
      routes,
      readManifest: async () => ({ version: '0.99.0', root: '/home/u/.dsh/profiles/web/node_modules/x/y' }),
      manager: () => managerOf(`${UPDATE_PACKAGE_NAME}@^0.99.0`, null),
    })
    const value = await check(origin)
    expect(value.updateAvailable).toBe(false)
    expect(value.canApply).toBe(false)
  })

  it('surfaces a failed install instead of swallowing its diagnostic', async () => {
    const routes: Route[] = []
    const origin = await mount({
      routes,
      manager: () => ({
        listBundles: async () => [{ name: UPDATE_PACKAGE_NAME, source: `${UPDATE_PACKAGE_NAME}@^0.34.0` }],
        installBundle: async () => ({ application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm: ENOSPC' } }),
      }),
    })
    const applied = await fetch(`${origin}${UPDATE_APPLY_PATH}`, { method: 'POST' })
    expect(applied.status).toBe(502)
    const body = await applied.json() as { ok: false; error: { code: string; message: string } }
    expect(body.error.code).toBe('install-failed')
    expect(body.error.message).toBe('pnpm: ENOSPC')
  })
})

describe('the one-tap update on a Host that refuses to install over an installed package', () => {
  it('installs directly and removes nothing when the Host accepts it', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({
      install: [{ application: 'restart-required', version: '0.35.0' }],
      remove: REMOVED,
    })
    const origin = await mount({ routes, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.status).toBe(200)
    expect(answered.value).toEqual({ installed: '0.35.0', restartRequired: true, removedFirst: false })
    // A Host that accepts the install never loses its working copy, not even
    // for the moment a remove would take.
    expect(manager.removes).toEqual([])
    expect(manager.installs).toEqual([`${UPDATE_PACKAGE_NAME}@latest`])
  })

  it('removes the installed copy, then installs again, when the first install is refused', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({
      install: [ALREADY_INSTALLED, APPLIED],
      remove: REMOVED,
    })
    const origin = await mount({ routes, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.status).toBe(200)
    // `restartRequired` follows the install's own `application`: this Host reloaded
    // the replaced bundle live, so nothing is left to restart.
    expect(answered.value).toEqual({ installed: '0.35.0', restartRequired: false, removedFirst: true })
    expect(manager.removes).toEqual([UPDATE_PACKAGE_NAME])
    expect(manager.installs).toEqual([`${UPDATE_PACKAGE_NAME}@latest`, `${UPDATE_PACKAGE_NAME}@latest`])
  })

  it('still asks for a restart when the Host did not reload the bundle itself', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({
      install: [ALREADY_INSTALLED, { application: 'restart-required', version: '0.35.0' }],
      remove: REMOVED,
    })
    const origin = await mount({ routes, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.value?.restartRequired).toBe(true)
    expect(answered.value?.removedFirst).toBe(true)
  })

  it('answers an older Host with no removeBundle exactly as before', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({ install: [{ application: 'restart-required', version: '0.35.0' }] })
    const origin = await mount({ routes, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.status).toBe(200)
    expect(answered.value).toEqual({ installed: '0.35.0', restartRequired: true, removedFirst: false })
    expect(manager.installs).toEqual([`${UPDATE_PACKAGE_NAME}@latest`])
  })

  it('refuses, without installing anything, when that older Host cannot remove either', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({ install: [ALREADY_INSTALLED] })
    const origin = await mount({ routes, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.status).toBe(502)
    expect(answered.error?.code).toBe('install-failed')
    expect(answered.error?.message).toContain(`dsh plugin add ${UPDATE_PACKAGE_NAME}@latest`)
    // No removal happened, so there is no rollback state to report.
    expect(answered.error?.rollback).toBeUndefined()
    expect(manager.installs).toEqual([`${UPDATE_PACKAGE_NAME}@latest`])
  })

  it('puts the previous version back when the installation after the removal fails', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({
      install: [ALREADY_INSTALLED, INSTALL_BROKEN, { application: 'restart-required', version: '0.34.0' }],
      remove: REMOVED,
    })
    const origin = await mount({ routes, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.status).toBe(502)
    expect(answered.error?.code).toBe('install-failed')
    expect(answered.error?.rollback).toBe('restored')
    expect(answered.error?.restoredVersion).toBe('0.34.0')
    // The failure reason survives beside the rollback: pnpm's output is the only
    // thing that says what went wrong.
    expect(answered.error?.message).toContain('pnpm: ENOSPC')
    expect(answered.error?.message).toContain('0.34.0')
    // The rollback installs the version this process read from its own manifest.
    expect(manager.installs).toEqual([
      `${UPDATE_PACKAGE_NAME}@latest`,
      `${UPDATE_PACKAGE_NAME}@latest`,
      `${UPDATE_PACKAGE_NAME}@0.34.0`,
    ])
  })

  it('says the plugin may be gone when the rollback fails as well', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({
      install: [ALREADY_INSTALLED, INSTALL_BROKEN, { application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm: E404' } }],
      remove: REMOVED,
    })
    const origin = await mount({ routes, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.status).toBe(502)
    expect(answered.error?.rollback).toBe('failed')
    expect(answered.error?.restoredVersion).toBeUndefined()
    // Both reasons are kept: the update's own, and the rollback's.
    expect(answered.error?.message).toContain('pnpm: ENOSPC')
    expect(answered.error?.message).toContain('pnpm: E404')
    expect(answered.error?.message).toContain('no longer installed')
    // …and the command a user needs to repair it by hand, pinned to the version
    // that was running rather than to `latest`.
    expect(answered.error?.message).toContain(`dsh plugin add ${UPDATE_PACKAGE_NAME}@0.34.0`)
  })

  it('skips the rollback when this process cannot read its own version', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({ install: [ALREADY_INSTALLED, INSTALL_BROKEN], remove: REMOVED })
    const origin = await mount({
      routes,
      readManifest: async () => ({ version: null, root: REGISTRY_INSTALL.root }),
      manager: () => manager,
    })
    const answered = await postApply(origin)
    expect(answered.error?.rollback).toBe('skipped')
    expect(answered.error?.message).toContain(`dsh plugin add ${UPDATE_PACKAGE_NAME}@latest`)
    // Nothing was attempted with a guessed version.
    expect(manager.installs).toEqual([`${UPDATE_PACKAGE_NAME}@latest`, `${UPDATE_PACKAGE_NAME}@latest`])
  })

  it('refuses, without a second install, when the Host needs the profile stopped', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({
      install: [ALREADY_INSTALLED],
      remove: { application: 'failed', changed: false, error: { code: 'stop-profile' } },
    })
    const origin = await mount({ routes, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.status).toBe(409)
    expect(answered.error?.code).toBe('stop-profile')
    expect(answered.error?.message).toContain('stop the Host')
    expect(answered.error?.message).toContain(`dsh plugin add ${UPDATE_PACKAGE_NAME}@latest`)
    // Installing over a copy that is still there would only be refused again.
    expect(manager.installs).toEqual([`${UPDATE_PACKAGE_NAME}@latest`])
  })

  it('reads a thrown stop-profile the same way as a returned one', async () => {
    const routes: Route[] = []
    const thrown = Object.assign(new Error('stop-profile'), { code: 'stop-profile' })
    const manager = scriptedManager({ install: [ALREADY_INSTALLED], remove: thrown })
    const origin = await mount({ routes, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.status).toBe(409)
    expect(answered.error?.code).toBe('stop-profile')
    expect(manager.installs).toEqual([`${UPDATE_PACKAGE_NAME}@latest`])
  })

  it('does not enter the removal path for an unrelated install failure', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({ install: [INSTALL_BROKEN], remove: REMOVED })
    const origin = await mount({ routes, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.status).toBe(502)
    expect(answered.error?.code).toBe('install-failed')
    expect(answered.error?.message).toBe('pnpm: ENOSPC')
    // Removing the working copy over an unrelated failure would turn a failed
    // update into an uninstalled plugin.
    expect(manager.removes).toEqual([])
    expect(manager.installs).toEqual([`${UPDATE_PACKAGE_NAME}@latest`])
  })

  it('never removes anything on a development link, even when the manager could', async () => {
    const routes: Route[] = []
    const manager = scriptedManager({ install: [], remove: REMOVED, source: 'link:/home/u/src/dsh-chatgpt-subscription' })
    const origin = await mount({ routes, readManifest: async () => LINKED_INSTALL, manager: () => manager })
    const answered = await postApply(origin)
    expect(answered.status).toBe(409)
    expect(answered.error?.code).toBe('development-install')
    expect(manager.installs).toEqual([])
    expect(manager.removes).toEqual([])
  })
})

describe('update routes and same-origin mutations', () => {
  it('rejects a cross-origin POST with 403 and installs nothing', async () => {
    const routes: Route[] = []
    const manager = managerOf(`${UPDATE_PACKAGE_NAME}@^0.34.0`, '0.35.0')
    const origin = await mount({ routes, manager: () => manager })
    const applied = await fetch(`${origin}${UPDATE_APPLY_PATH}`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    })
    expect(applied.status).toBe(403)
    expect((await applied.json() as { error: { code: string } }).error.code).toBe('csrf-rejected')
    expect(manager.installs).toEqual([])
  })

  it('keeps the check GET-only and the apply POST-only', async () => {
    const routes: Route[] = []
    const origin = await mount({ routes })
    expect((await fetch(`${origin}${UPDATE_CHECK_PATH}`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${origin}${UPDATE_APPLY_PATH}`)).status).toBe(405)
  })
})

describe('the update routes beside the provider prefix route', () => {
  it('answers from their own exact handlers even though the shared prefix handler owns the rest', async () => {
    const routes: Route[] = []
    // The real registrations, in the order src/index.ts applies them: the
    // provider prefix table first (it answers 405 to every non-POST request under
    // its path), then the update routes.
    const store = new MemoryTokenStore()
    await store.save({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'account-secret-1234',
      email: 'owner@example.com',
      planType: 'plus',
    })
    const oauth = new OAuthService(store, { logger: { info: () => undefined, warn: () => undefined } })
    const usage = new UsageService(oauth, { fetchFn: async () => Response.json({ plan_type: 'plus' }) })
    const preferences = {
      status: () => ({
        quickQuotaVisible: false,
        fastMode: false,
        outputVerbosity: null,
        reasoningSummary: null,
        visibleModelIds: ['gpt-5.6-sol'],
        searchProvider: 'dsh',
        contextWindowOverrides: {},
        proxyMode: 'auto',
        customProxyUrl: null,
        writable: true,
      }),
      update: async () => preferences.status(),
      watch: () => () => undefined,
    } as unknown as SubscriptionPreferenceStore
    registerRoutes({ webServer: { register(route: Route) { routes.push(route); return () => undefined } } } as never, oauth, usage, preferences)

    const origin = await mount({ routes, manager: () => managerOf(`${UPDATE_PACKAGE_NAME}@^0.34.0`, '0.35.0') })
    expect((await check(origin)).latest).toBe('0.99.0')
    const applied = await fetch(`${origin}${UPDATE_APPLY_PATH}`, { method: 'POST' })
    expect(applied.status).toBe(200)
    // …and the prefix handler still owns everything it owned before.
    expect((await fetch(`${origin}/api/dsh-chatgpt-subscription/preferences/update`)).status).toBe(405)
  })
})

describe('install kind from the installed path', () => {
  it('reads a resolved copy as a registry install and a checkout as a link', () => {
    expect(installKindFromPath('/home/u/.dsh/profiles/web/node_modules/@scope/pkg')).toBe('registry')
    expect(installKindFromPath('C:\\Users\\u\\.dsh\\profiles\\web\\node_modules\\@scope\\pkg')).toBe('registry')
    expect(installKindFromPath('/home/u/src/pkg')).toBe('link')
    // A directory that merely starts with the word is not the real segment.
    expect(installKindFromPath('/home/u/node_modules-backup/pkg')).toBe('link')
  })
})

describe('readOwnManifest', () => {
  it('finds this checkout through the bounded walk and reads its version', async () => {
    const manifest = await readOwnManifest()
    expect(manifest).not.toBeNull()
    // Read the same file independently so a version bump cannot break the pin.
    const expected = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(manifest?.version).toBe(expected.version)
    // This test itself runs from the source tree, which is a development link.
    expect(manifest === null ? null : installKindFromPath(manifest.root)).toBe('link')
  })

  it('answers null when no ancestor directory holds this package', async () => {
    // A path near a filesystem root climbs out without ever matching this name.
    expect(await readOwnManifest('/definitely/not/this/package/index.js')).toBeNull()
  })
})

describe('semver comparison', () => {
  /** The comparison, with an unparsable answer spelled as NaN so the assertions stay numeric. */
  const cmp = (left: string, right: string): number => compareVersions(left, right) ?? Number.NaN

  it('orders the numeric triple', () => {
    expect(cmp('0.34.0', '0.35.0')).toBeLessThan(0)
    expect(cmp('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(cmp('0.34.0', '0.34.0')).toBe(0)
    expect(cmp('v0.34.0', '0.34.0')).toBe(0)
  })

  it('sorts a prerelease below the release of the same numbers', () => {
    expect(cmp('0.34.0-alpha.0', '0.34.0')).toBeLessThan(0)
    expect(cmp('0.34.0', '0.34.0-rc.1')).toBeGreaterThan(0)
    expect(cmp('0.34.0-alpha.0', '0.34.0-alpha.1')).toBeLessThan(0)
    // A numeric identifier ranks below an alphanumeric one.
    expect(cmp('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  it('answers null for anything it cannot order', () => {
    expect(compareVersions('latest', '0.34.0')).toBeNull()
    expect(compareVersions('0.34', '0.34.0')).toBeNull()
  })
})
