/**
 * The hub's update routes: "is there a newer version of this plugin, and may I
 * install it from here?"
 *
 * The check is a read — it asks the npm registry one question and reports how
 * this copy reached the disk — and the apply is the one mutation in this
 * plugin's route table that changes the plugin itself. Both live here rather
 * than in `routes.ts` because they belong to no subscription line.
 *
 * Three guards decide whether a one-tap update is even possible, and they are
 * answered before the button is offered so a click never fails:
 *
 * 1. A `link:`/`file:` install is a developer's working tree; installing over it
 *    would replace the files being edited. Detected through the plugin manager
 *    when it is available (its bundle list carries the spec pnpm would accept,
 *    which keeps the `link:`/`file:` protocol) and through the installed path
 *    otherwise (a development dependency resolves outside `node_modules`).
 * 2. No `pluginManager` service means nothing here can run pnpm.
 * 3. A registry that does not answer means there is no version to install.
 *
 * The spec installed by the POST is `UPDATE_INSTALL_SPEC`, a constant. Nothing
 * from the request body is read, so a same-origin POST cannot choose what gets
 * installed into the profile.
 *
 * On a Host running an HMR profile a one-tap update cannot be a single install:
 * its `installBundle` refuses to install over a package the profile already has
 * (`already-installed`). The official plugin manager's own update action handles
 * that by removing the installed copy first, and this route follows the same
 * path: try the direct install, fall back to remove-then-install only for that
 * refusal, and put the previous version back when the second install fails. The
 * direct attempt comes first so the copy on disk is never removed on a Host that
 * would have accepted the install.
 */
import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ApiEnvelope } from '../shared/contracts.ts'
import {
  UPDATE_CHECK_PATH, UPDATE_APPLY_PATH, UPDATE_INSTALL_SPEC, UPDATE_MANUAL_COMMAND,
  UPDATE_PACKAGE_NAME, UPDATE_REGISTRY_URL, updateAddCommand,
} from '../shared/update-contracts.ts'
import type {
  UpdateApplyDto, UpdateBlockedReason, UpdateCheckDto, UpdateFailureDto, UpdateInstallKind, UpdateRollback,
} from '../shared/update-contracts.ts'
import { isSameOriginMutation } from './common/same-origin.ts'

export { UPDATE_CHECK_PATH, UPDATE_APPLY_PATH }

/**
 * How many directories the manifest walk climbs.
 *
 * A bundled copy sits at `<root>/lib/index.js` and a source copy at
 * `<root>/src/host/update-check.ts`, so the answer is one or two hops in both
 * postures. The bound exists to stop the walk at a filesystem root instead of
 * letting a mis-placed module scan the whole disk.
 */
const MANIFEST_WALK_DEPTH = 6

/** How long the registry gets to answer before the check reports itself failed. */
const REGISTRY_TIMEOUT_MS = 8_000

/** The manifest this process is running from. */
export interface OwnManifest {
  /** The `version` field, or null when the manifest carries none. */
  version: string | null
  /** Directory holding that `package.json`: the plugin root, before symlinks are resolved. */
  root: string
}

/**
 * The `pluginManager` service as these routes use it.
 *
 * Structural rather than imported: the service ships with the Host, and this
 * plugin supports a peer range that predates it, so a build must compile (and
 * run) on a Host that never provides it.
 */
export interface UpdatePluginManager {
  /** Installed bundles with the spec pnpm would accept; absent on older managers. */
  listBundles?(): Promise<readonly UpdateBundleRow[]>
  /** Install one spec, as `dsh plugin add` would. */
  installBundle(spec: string, options?: {
    enabled?: boolean
    requestId?: string
  }): Promise<UpdateChangeResult>
  /**
   * Remove one installed bundle, as `dsh plugin remove` would.
   *
   * Optional because older Hosts do not expose it: the update then has only the
   * direct-install path, exactly as before this field existed.
   */
  removeBundle?(name: string): Promise<UpdateChangeResult>
}

/** The fields of one bundle row these routes read. */
export interface UpdateBundleRow {
  name: string
  /** The installable spec; carries `link:`/`file:` for a local dependency. */
  source?: string
  version?: string
}

/** The fields of one install result these routes read. */
export interface UpdateChangeResult {
  application?: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  version?: string
  /** Whether the profile files actually changed; a removal that reports false removed nothing. */
  changed?: boolean
  error?: { code?: string; diagnostic?: string }
  packageResult?: { output?: string }
}

export interface UpdateRouteOptions {
  /**
   * The fetch the registry question goes through.
   *
   * The Host's proxy-aware fetch, for the same reason every other line takes
   * one: this deployment reaches the network through a local proxy, and a bare
   * `fetch` would fail on a machine where every other request succeeds.
   */
  fetchFn?: typeof fetch
  /** Test seam: where the running copy's manifest is read from. */
  readManifest?: () => Promise<OwnManifest | null>
  /** Test seam: the plugin manager this Host exposes; defaults to `ctx.get('pluginManager')`. */
  manager?: () => UpdatePluginManager | null
}

/**
 * Read this process's own manifest, climbing at most {@link MANIFEST_WALK_DEPTH} directories.
 *
 * The start point is this module's own URL, never a fixed relative path: a
 * bundled copy lives at `<root>/lib/index.js` and a source copy at
 * `<root>/src/host/update-check.ts`, so `../package.json` names two different
 * files depending on how the plugin was loaded. A `package.json` is accepted
 * only when its `name` is this package, which also stops the walk at a
 * workspace root that shares the directory tree.
 *
 * @param fromFile - The module URL to start from; defaults to this module's.
 * @returns the manifest, or null when no ancestor directory holds one.
 */
export async function readOwnManifest(fromFile: string = fileURLToPath(import.meta.url)): Promise<OwnManifest | null> {
  let directory = dirname(fromFile)
  for (let depth = 0; depth <= MANIFEST_WALK_DEPTH; depth += 1) {
    const manifest = await readJsonObject(join(directory, 'package.json'))
    if (manifest?.name === UPDATE_PACKAGE_NAME) {
      return { version: typeof manifest.version === 'string' ? manifest.version : null, root: directory }
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
  return null
}

/** Read one JSON object, answering null for a missing, unreadable, or non-object file. */
async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * Whether an installed copy is a local development link.
 *
 * A package installed from the registry resolves through a `node_modules`
 * directory; a `link:`/`file:` dependency resolves to wherever its author keeps
 * the sources, which is not under one. Matching whole path segments rather than
 * a substring keeps a directory named `node_modules-backup` from passing for
 * the real thing.
 *
 * @param root - The plugin root, after symlinks are resolved.
 * @returns the kind the path implies.
 */
export function installKindFromPath(root: string): UpdateInstallKind {
  return root.split(/[\\/]+/).includes('node_modules') ? 'registry' : 'link'
}

/**
 * The install kind the plugin manager reports, when it can report one.
 *
 * `listBundles` is the authoritative source: its `source` is the spec
 * `pnpm add` would take, produced from the profile manifest, so a `link:` or
 * `file:` dependency is still recognisable there even when the resolved
 * directory happens to sit under `node_modules`.
 *
 * @returns the kind, or null when this manager cannot say.
 */
async function installKindFromManager(manager: UpdatePluginManager | null): Promise<UpdateInstallKind | null> {
  if (manager === null || typeof manager.listBundles !== 'function') return null
  let rows: readonly UpdateBundleRow[]
  try {
    rows = await manager.listBundles()
  } catch {
    return null
  }
  const row = rows.find((entry) => entry.name === UPDATE_PACKAGE_NAME)
  const source = row?.source
  if (source === undefined || source === '') return null
  // A dependency installed under another name reads `<other-name>@link:/abs`.
  const protocol = /^(?:[^:@/]*@)?(link|file):/.exec(source)?.[1]
  if (protocol === 'link' || protocol === 'file') return protocol
  return 'registry'
}

/** Resolve how this copy reached the disk, preferring the manager's own answer. */
async function resolveInstallKind(manifest: OwnManifest | null, manager: UpdatePluginManager | null): Promise<UpdateInstallKind> {
  const reported = await installKindFromManager(manager)
  if (reported !== null) return reported
  if (manifest === null) return 'unknown'
  // Resolve symlinks first: a `link:` dependency's directory can BE a symlink
  // into `node_modules`, and the installed location is what decides.
  const resolved = await realpath(manifest.root).catch(() => manifest.root)
  return installKindFromPath(resolved)
}

/** One parsed version: the numeric triple and the prerelease tail, if any. */
interface ParsedVersion {
  parts: [number, number, number]
  prerelease: string | null
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse a semver string, answering null for anything this comparison cannot order. */
function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim())
  if (match === null) return null
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  }
}

/**
 * Compare two semver strings, prerelease versions included.
 *
 * Only what this feature needs is implemented — the numeric triple, and the rule
 * that a prerelease sorts below the same numbers' release. Build metadata is
 * ignored, as semver requires. A dot-separated prerelease tail is compared
 * identifier by identifier: numeric identifiers numerically, alphanumeric ones
 * by ASCII order, and a numeric identifier sorts below an alphanumeric one.
 *
 * @returns a negative number when `left` is older, 0 when equal, a positive
 * number when newer, and null when either side is not a version this can order.
 */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return null
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.parts[index] as number) - (b.parts[index] as number)
    if (difference !== 0) return difference
  }
  if (a.prerelease === b.prerelease) return 0
  // No prerelease means the release, which outranks any prerelease of the same numbers.
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  const left_ids = a.prerelease.split('.')
  const right_ids = b.prerelease.split('.')
  for (let index = 0; index < Math.max(left_ids.length, right_ids.length); index += 1) {
    const one = left_ids[index]
    const other = right_ids[index]
    // A shorter identifier list is the smaller one when everything shared matches.
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue
    const oneNumeric = /^\d+$/.test(one)
    const otherNumeric = /^\d+$/.test(other)
    if (oneNumeric && otherNumeric) return Number(one) - Number(other)
    if (oneNumeric) return -1
    if (otherNumeric) return 1
    return one < other ? -1 : 1
  }
  return 0
}

/**
 * Ask the registry for the newest published version.
 *
 * Every failure — a refused connection, a proxy that will not answer, a timeout,
 * an HTML error page, a document without a `version` — is answered as null and
 * becomes `registry-unreachable` on the wire. The check is a convenience: a 500
 * here would read as "this plugin is broken" for a machine that is merely
 * offline.
 */
async function readLatestPublishedVersion(fetchFn: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchFn(UPDATE_REGISTRY_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    const version = (body as { version?: unknown } | null)?.version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}

/** The manager this Host exposes, if it exposes one at all. */
function resolveManager(ctx: Context, options: UpdateRouteOptions): UpdatePluginManager | null {
  if (options.manager !== undefined) return options.manager()
  const lookup = (ctx as { get?: (name: string) => unknown }).get
  if (typeof lookup !== 'function') return null
  return (lookup.call(ctx, 'pluginManager') as UpdatePluginManager | undefined) ?? null
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

function sendMethodNotAllowed(response: ServerResponse, allow: string): void {
  response.writeHead(405, { allow, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ ok: false, error: { code: 'bad-request', message: 'Method not allowed.' } }))
}

function sendFailure(
  response: ServerResponse,
  status: number,
  code: UpdateFailureDto['error']['code'],
  message: string,
  extra: Pick<UpdateFailureDto['error'], 'rollback' | 'restoredVersion'> = {},
): void {
  sendJson(response, status, { ok: false, error: { code, message, ...extra } } satisfies UpdateFailureDto)
}

/** Wording shared by both routes, so a refusal reads the same wherever it happens. */
function developmentInstallMessage(): string {
  return `This copy is installed from a local path, so replacing it would overwrite the working tree it was linked from. Run ${UPDATE_MANUAL_COMMAND} to install the published package instead.`
}

/**
 * Why a one-tap update is unavailable, when it is.
 *
 * @param latest - The published version, null when the registry did not answer.
 * @param installKind - How this copy reached the disk.
 * @param hasManager - Whether a plugin manager can install.
 * @returns the blocking reason, or undefined when the offer stands.
 */
function blockedReasonFor(
  latest: string | null,
  installKind: UpdateInstallKind,
  hasManager: boolean,
): UpdateBlockedReason | undefined {
  // A failed check comes first: with no published version there is nothing to
  // install, whatever the other two facts say.
  if (latest === null) return 'registry-unreachable'
  if (installKind === 'link' || installKind === 'file') return 'development-install'
  if (!hasManager) return 'plugin-manager-missing'
  // An unknown install kind still answers no reason: the caller's `canApply`
  // requires `registry`, and an unreadable manifest leaves nothing to compare,
  // so the offer is withheld by those two facts rather than by a third wording.
  return undefined
}

/** Wordings for the refusals whose bare code says nothing to a reader. */
const INSTALL_FAILURE_HINTS: Readonly<Record<string, string>> = {
  'already-installed': 'This Host applies plugin changes itself and will not install over a package it already has; remove the plugin, then install it again from Settings › Plugins.',
  'not-bundle': 'The published package declares no bundle patch, so this Host would not load it.',
  'incompatible-version': 'The published package rejects the running DSH version.',
}

/** The error text of anything thrown, for a diagnostic that has to stay readable. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The machine-readable code a thrown manager failure carries, when it has one.
 *
 * The manager folds its own refusals into a returned result, but the same
 * refusals can still arrive as a thrown error — a lock, a direct call to a
 * private path — carrying the code as a property. Reading it keeps
 * `already-installed` recognisable either way, which is what decides whether the
 * update may remove the installed copy at all.
 */
function thrownCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Install one spec, folding a rejected call into a reported result.
 *
 * `waitForInstall` is deliberately not consulted afterwards: it exists to recover
 * a response lost on the remote wire, whereas this call runs in the Host's own
 * process and resolves with the settled result (the manager drops its entry
 * before the call settles, so a wait would always answer null).
 *
 * @param manager - The Host's plugin manager.
 * @param spec - The exact spec to install; always one this module wrote down.
 * @returns the settled result, or a `failed` one when the call threw.
 */
async function installSpec(manager: UpdatePluginManager, spec: string): Promise<UpdateChangeResult> {
  try {
    // The request id groups the install's progress and log chunks under this one click.
    return await manager.installBundle(spec, { enabled: true, requestId: randomUUID() })
  } catch (error) {
    // The manager folds most failures into its result, so a rejection means the
    // call itself could not run: a profile lock, a disposed manager. Still an
    // outcome to report, not a 500 to throw.
    return { application: 'failed', error: { code: thrownCode(error) ?? 'operation-error', diagnostic: messageOf(error) } }
  }
}

/**
 * Remove the installed copy of this package.
 *
 * @param manager - The Host's plugin manager.
 * @returns the settled result; `remove-unavailable` when this Host is too old to
 * remove a bundle, and `operation-error` when the call threw.
 */
async function removeInstalledCopy(manager: UpdatePluginManager): Promise<UpdateChangeResult> {
  if (typeof manager.removeBundle !== 'function') {
    return { application: 'failed', error: { code: 'remove-unavailable', diagnostic: 'This Host exposes no removeBundle.' } }
  }
  try {
    return await manager.removeBundle(UPDATE_PACKAGE_NAME)
  } catch (error) {
    return { application: 'failed', error: { code: thrownCode(error) ?? 'operation-error', diagnostic: messageOf(error) } }
  }
}

/** Whether a change settled the way a caller needs it to. */
function settled(result: UpdateChangeResult): boolean {
  return result.application !== 'failed' && result.application !== 'cancelled'
}

/** One successful apply, with `restartRequired` read from the install's own answer. */
function appliedOutcome(result: UpdateChangeResult, removedFirst: boolean): ApplyOutcome {
  return {
    ok: true,
    installed: result.version ?? 'unknown',
    // A Host running an HMR profile reloads the replaced bundle live and answers
    // `applied`; anything else leaves the loaded modules on the old version.
    restartRequired: result.application !== 'applied',
    removedFirst,
  }
}

/** The settled outcome of one apply, before it becomes an HTTP status. */
type ApplyOutcome =
  | { ok: true; installed: string; restartRequired: boolean; removedFirst: boolean }
  | {
    ok: false
    code: UpdateFailureDto['error']['code']
    message: string
    rollback?: UpdateRollback
    restoredVersion?: string
  }

/**
 * Why the removal the official update path needs did not happen.
 *
 * Nothing is installed after this: with the working copy still on disk (or in a
 * state this route cannot read) the only honest outcome is a refusal that names
 * the way out.
 */
function removalFailureMessage(result: UpdateChangeResult): Pick<Extract<ApplyOutcome, { ok: false }>, 'code' | 'message'> {
  const code = result.error?.code
  if (code === 'stop-profile') {
    return {
      code: 'stop-profile',
      message: `This Host will not remove a plugin its running profile has loaded, so the profile has to be stopped before it can be updated: stop the Host, run ${UPDATE_MANUAL_COMMAND}, then start it again. Settings › Plugins performs the same removal.`,
    }
  }
  if (code === 'remove-unavailable') {
    return {
      code: 'install-failed',
      message: `This Host refuses to install over a package it already has and offers no way to remove one, so the update cannot run here. Run ${UPDATE_MANUAL_COMMAND} by hand.`,
    }
  }
  if (settled(result) && result.changed === false) {
    return {
      code: 'install-failed',
      message: `The Host reported the removal without changing the profile, so the installed copy is still there and nothing was installed. Run ${UPDATE_MANUAL_COMMAND} by hand.`,
    }
  }
  const detail = result.error?.diagnostic ?? result.packageResult?.output?.trim()
  const reason = [ 'Removing the installed copy failed, so the new version was not installed.', detail ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ')
  return { code: 'install-failed', message: `${reason} Run ${UPDATE_MANUAL_COMMAND} by hand.` }
}

/**
 * Put the previously running version back after an installation failed.
 *
 * The removal already happened by this point, so there is no working copy on
 * disk and nothing else will restore one. The version reinstall comes from the
 * manifest this process read itself — never from the request — and an unreadable
 * version skips the rollback rather than guessing one. The outcome is reported
 * either way: a card that showed only "failed" would leave the user with a
 * plugin that may no longer be installed.
 */
async function rollBackAfterFailedUpdate(
  manager: UpdatePluginManager,
  currentVersion: string | null,
  failed: UpdateChangeResult,
): Promise<ApplyOutcome> {
  const reason = installFailureMessage(failed)
  if (currentVersion === null) {
    return {
      ok: false,
      code: 'install-failed',
      rollback: 'skipped',
      message: `${reason} The installed copy had already been removed and this process could not read its own version, so it was not put back. Run ${UPDATE_MANUAL_COMMAND} to install the plugin again.`,
    }
  }
  const spec = `${UPDATE_PACKAGE_NAME}@${currentVersion}`
  const restored = await installSpec(manager, spec)
  if (settled(restored)) {
    const version = restored.version ?? currentVersion
    return {
      ok: false,
      code: 'install-failed',
      rollback: 'restored',
      restoredVersion: version,
      message: `${reason} ${version} was installed again, so the plugin keeps running as it did before.`,
    }
  }
  return {
    ok: false,
    code: 'install-failed',
    rollback: 'failed',
    message: `${reason} Putting ${currentVersion} back failed as well (${installFailureMessage(restored)}), so the plugin is most likely no longer installed. Reinstall it by hand with ${updateAddCommand(spec)} and restart the Host.`,
  }
}

/**
 * Install the published version, taking the official update path when this Host
 * refuses to install over a package it already has.
 *
 * The order is deliberate: the direct installation runs first, so a Host without
 * HMR — and any Host that accepts the install — never loses its working copy for
 * even a moment. Only the refusal an existing installation causes falls through
 * to remove-then-install, and only that path can report a rollback.
 */
async function applyPublishedUpdate(manager: UpdatePluginManager, currentVersion: string | null): Promise<ApplyOutcome> {
  const direct = await installSpec(manager, UPDATE_INSTALL_SPEC)
  if (settled(direct)) return appliedOutcome(direct, false)
  if (direct.error?.code !== 'already-installed') {
    // Nothing about this failure involves the copy already on disk, so removing
    // it would turn a failed update into an uninstalled plugin.
    return { ok: false, code: 'install-failed', message: installFailureMessage(direct) }
  }
  const removed = await removeInstalledCopy(manager)
  if (!settled(removed) || removed.changed === false) {
    return { ok: false, ...removalFailureMessage(removed) }
  }
  const replaced = await installSpec(manager, UPDATE_INSTALL_SPEC)
  if (settled(replaced)) return appliedOutcome(replaced, true)
  return await rollBackAfterFailedUpdate(manager, currentVersion, replaced)
}

/**
 * Why an installation did not happen, in the words the caller should read.
 *
 * The diagnostic is carried through rather than swallowed: pnpm's own output is
 * the only thing that says what went wrong, and a card that replaced it with
 * "failed" would leave the user with nothing to act on.
 */
function installFailureMessage(result: UpdateChangeResult): string {
  const code = result.error?.code
  const hint = code === undefined ? undefined : INSTALL_FAILURE_HINTS[code]
  const detail = result.error?.diagnostic ?? result.packageResult?.output?.trim()
  const parts = [hint, detail].filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? 'The installation did not complete.' : parts.join(' ')
}

/**
 * Register the update check and the one-tap update.
 *
 * @param ctx - Host context whose `webServer` takes the two exact routes.
 * @param options - The proxy-aware fetch and the two test seams.
 * @returns a disposer for both routes.
 */
export function registerUpdateRoutes(ctx: Context, options: UpdateRouteOptions = {}): () => void {
  const fetchFn = options.fetchFn ?? fetch
  const readManifest = options.readManifest ?? (() => readOwnManifest())

  const checkHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // The check is a read: it never mutates anything, and refusing every other
    // method keeps a stray POST from reaching the registry on this path.
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'GET')
      return
    }
    const checkedAt = Date.now()
    const manifest = await readManifest()
    const manager = resolveManager(ctx, options)
    const current = manifest?.version ?? null
    const [latest, installKind] = await Promise.all([
      readLatestPublishedVersion(fetchFn),
      resolveInstallKind(manifest, manager),
    ])
    const comparison = current === null || latest === null ? null : compareVersions(latest, current)
    const updateAvailable = comparison !== null && comparison > 0
    const reason = blockedReasonFor(latest, installKind, manager !== null)
    const value: UpdateCheckDto = {
      current,
      latest,
      updateAvailable,
      installKind,
      // Installing is offered only when there is something to install AND every
      // guard agrees; an unreadable install kind is not something to build a
      // one-tap replacement on.
      canApply: updateAvailable && reason === undefined && installKind === 'registry',
      ...(reason === undefined ? {} : { reason }),
      command: UPDATE_MANUAL_COMMAND,
      checkedAt,
    }
    sendJson(response, 200, { ok: true, value } satisfies ApiEnvelope<UpdateCheckDto>)
  }

  const applyHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'POST')
      return
    }
    // A POST that installs a package into this profile is as consequential as a
    // mutation gets, so it carries the same origin proof as every other one.
    if (!isSameOriginMutation(request)) {
      sendFailure(response, 403, 'csrf-rejected', 'Cross-origin request rejected.')
      return
    }
    const manifest = await readManifest()
    const manager = resolveManager(ctx, options)
    const installKind = await resolveInstallKind(manifest, manager)
    // The order is the order the card guards in, so a host that answers the
    // check one way cannot answer the apply the other.
    if (installKind === 'link' || installKind === 'file') {
      sendFailure(response, 409, 'development-install', developmentInstallMessage())
      return
    }
    if (manager === null) {
      sendFailure(response, 409, 'plugin-manager-missing', `This Host exposes no plugin manager, so the update cannot run here. Run ${UPDATE_MANUAL_COMMAND} instead.`)
      return
    }
    const outcome = await applyPublishedUpdate(manager, manifest?.version ?? null)
    if (!outcome.ok) {
      sendFailure(response, outcome.code === 'stop-profile' ? 409 : 502, outcome.code, outcome.message, {
        ...(outcome.rollback === undefined ? {} : { rollback: outcome.rollback }),
        ...(outcome.restoredVersion === undefined ? {} : { restoredVersion: outcome.restoredVersion }),
      })
      return
    }
    const value: UpdateApplyDto = {
      installed: outcome.installed,
      restartRequired: outcome.restartRequired,
      removedFirst: outcome.removedFirst,
    }
    sendJson(response, 200, { ok: true, value } satisfies ApiEnvelope<UpdateApplyDto>)
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: UPDATE_CHECK_PATH, handler: checkHandler }),
    ctx.webServer.register({ kind: 'exact', path: UPDATE_APPLY_PATH, handler: applyHandler }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
