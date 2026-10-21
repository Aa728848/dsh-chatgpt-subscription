/**
 * Wire contracts for the hub overview's "check for updates / update this plugin"
 * control.
 *
 * Two routes: a GET that answers what the registry offers, how this copy reached
 * the disk, and whether this process may install it; and a POST that runs that
 * install. Everything here is a non-secret fact a settings card may render. The
 * spec the install runs is written down on the server (`UPDATE_INSTALL_SPEC`) and
 * is never read from this wire, so nothing a client sends can change which
 * package or version gets installed.
 */
import { ROUTE_PREFIX } from '../compat.ts'

/** The package this build is. Both routes act on this one name only. */
export const UPDATE_PACKAGE_NAME = '@eddyskywalker/dsh-chatgpt-subscription' as const

/**
 * The exact spec the one-tap update installs.
 *
 * Written here rather than accepted from the request body: a route that took the
 * package name from its caller would let any same-origin POST install an
 * arbitrary package into the profile.
 */
export const UPDATE_INSTALL_SPEC = `${UPDATE_PACKAGE_NAME}@latest` as const

/** The registry document the version check reads (scoped packages take this slash form). */
export const UPDATE_REGISTRY_URL = `https://registry.npmjs.org/${UPDATE_PACKAGE_NAME}/latest` as const

/**
 * The `dsh plugin add` command for one exact install spec.
 *
 * The manual recovery path after a failed update needs a command pinned to the
 * version that was running, not `@latest`: reinstalling `@latest` right after a
 * failed attempt would repeat the same install. Both commands are built here so
 * the wording of "add this spec by hand" exists once.
 *
 * @param spec - The install spec; defaults to {@link UPDATE_INSTALL_SPEC}.
 * @returns the command line a user can paste into a terminal.
 */
export function updateAddCommand(spec: string = UPDATE_INSTALL_SPEC): string {
  return `dsh plugin add ${spec}`
}

/** The command a user runs by hand when the card cannot install for them. */
export const UPDATE_MANUAL_COMMAND = updateAddCommand()

export const UPDATE_CHECK_PATH = `${ROUTE_PREFIX}/update/check` as const
export const UPDATE_APPLY_PATH = `${ROUTE_PREFIX}/update/apply` as const

/** How the running copy of this plugin reached the disk. */
export type UpdateInstallKind = 'registry' | 'link' | 'file' | 'unknown'

/**
 * Why one-tap installation is unavailable, when it is.
 *
 * - `development-install`: the running copy is a `link:`/`file:` dependency, so
 *   installing over it would replace the very working tree a developer edits.
 * - `plugin-manager-missing`: this Host exposes no `pluginManager` service, so
 *   nothing here can run pnpm.
 * - `registry-unreachable`: the version check itself failed, so there is nothing
 *   to install yet.
 */
export type UpdateBlockedReason = 'development-install' | 'plugin-manager-missing' | 'registry-unreachable'

/**
 * The answer to one version check.
 *
 * The four outcomes the card renders are derivable from these fields alone:
 *
 * | outcome | fields |
 * | --- | --- |
 * | already latest | `latest` set, `updateAvailable: false`, no `reason` |
 * | new version, one tap | `updateAvailable: true`, `canApply: true` |
 * | new version, manual only | `updateAvailable: true`, `canApply: false`, `reason` set |
 * | check failed | `latest: null`, `reason: 'registry-unreachable'` |
 */
export interface UpdateCheckDto {
  /**
   * The version this process is running, or null when the manifest could not be
   * located (the card then says "unknown" instead of inventing one).
   */
  current: string | null
  /** The newest published version, or null when the registry did not answer. */
  latest: string | null
  /** `latest` is strictly newer than `current`. */
  updateAvailable: boolean
  /** How this copy reached the disk, as the plugin manager or the path shows. */
  installKind: UpdateInstallKind
  /** Whether `POST` can install it here. */
  canApply: boolean
  /** Present exactly when `canApply` is false for a reason worth telling. */
  reason?: UpdateBlockedReason
  /** The command to run by hand; always present so every outcome has an escape hatch. */
  command: string
  /** When the registry was asked, as Unix milliseconds. */
  checkedAt: number
}

/** What happened when a failed installation tried to put the previous version back. */
export type UpdateRollback = 'restored' | 'failed' | 'skipped'

/** The answer to a successful one-tap update. */
export interface UpdateApplyDto {
  /**
   * The version now on disk.
   *
   * It is the manifest version pnpm actually installed, which a supply-chain
   * policy such as `minimumReleaseAge` can hold below the newest release.
   */
  installed: string
  /**
   * Whether the running process still holds the previous version's modules.
   *
   * Taken from the install's own `application` field rather than assumed: a Host
   * running an HMR profile reloads the replaced bundle live and answers
   * `applied`, in which case nothing is left to restart.
   */
  restartRequired: boolean
  /**
   * Whether the update ran the official remove-then-install path.
   *
   * An HMR profile refuses to install over a package it already has, so the
   * update first removes the installed copy. That is visible on the wire instead
   * of hidden, because it is the one update path that leaves the plugin briefly
   * uninstalled.
   */
  removedFirst: boolean
}

/** The failure codes the apply route answers with, so the card can word them. */
export type UpdateFailureCode =
  | 'development-install'
  | 'plugin-manager-missing'
  /** The Host will not remove a plugin a running profile has loaded, so it must be stopped first. */
  | 'stop-profile'
  | 'install-failed'
  | 'csrf-rejected'

/** A refused update. An `ApiEnvelope` with `ok: false` and one of these codes. */
export interface UpdateFailureDto {
  ok: false
  error: {
    code: UpdateFailureCode
    message: string
    /**
     * Present when the failure happened on the remove-then-install path: whether
     * the previous version was put back. A card that stayed silent here would
     * leave a user with a plugin that may no longer be installed.
     */
    rollback?: UpdateRollback
    /** The version the rollback reinstalled, present exactly when `rollback` is `restored`. */
    restoredVersion?: string
  }
}
