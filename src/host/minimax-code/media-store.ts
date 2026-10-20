/**
 * Where a generated video is written, and how the path it gets is derived.
 *
 * WHY THE SESSION WORKSPACE AND NOT A PRIVATE DIRECTORY. The sidebar's video
 * preview is a DOCUMENT preview: it renders a file the workspace can address,
 * because that is what the preview registry is keyed on. A clip parked in
 * `$DSH_HOME/storages/...` — which is where the Kimi line's attachment store
 * lives — is invisible to that surface: the tool would report success and the
 * user would have no player to open it in. So the bytes land in the session's
 * own working directory, and this module's whole job is to do that without
 * letting a caller name a path.
 *
 * HOW THE ROOT IS RESOLVED (the answer to "what can a tool actually see here"):
 *
 * 1. `ctx.get('workingDirectory')` then `ensure(agent, signal)` — the same call
 *    the harness itself makes. `packages/core/tools/src/index.ts:949-956` uses
 *    it to capture `run_code`'s cwd, and `packages/deliverables/tool-present/
 *    src/index.ts:82` uses it to resolve the directory `present` addresses.
 *    It is the CURRENT directory, which is what a user means by "the
 *    workspace" after they change it mid-session.
 * 2. `agent.session.header.cwd` — `packages/core/session/src/types.ts:106`
 *    documents it as "Absolute working directory the session was created in".
 *    This is the fallback when the working-directory service is not composed
 *    (a headless host), and it is a plain field, so reading it cannot fail.
 * 3. Neither: the call FAILS. There is deliberately no third fallback to a
 *    plugin-owned directory, because the product contract is that the file is
 *    reachable from the workspace; silently writing somewhere else would report
 *    a success the user cannot open. The error names both remedies.
 *
 * The host's own workspace-file scope agrees with the same decision:
 * `packages/api/workspace-files/src/index.ts:218` resolves a session's root as
 * `header.cwd ?? scope.sandboxPolicy.workspaceRoot`, i.e. the header first.
 *
 * @module dsh-chatgpt-subscription/minimax-code/media-store
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Largest single generated video this route will write.
 *
 * A 15-second 2K H3 clip is a few tens of megabytes, so 200 MB is not a
 * prediction of the output size — it is the ceiling that stops a runaway
 * download (a wrong URL that streams an ISO, a redirect to something huge) from
 * filling the user's disk. Nothing legitimate comes near it.
 */
export const MAX_GENERATED_VIDEO_BYTES = 200 * 1024 * 1024

/** Directory, under the workspace root, that generated videos land in. */
export const GENERATED_VIDEO_DIR = 'minimax-videos'

/** Raised when a write cannot produce a usable workspace path. */
export class MediaStoreError extends HarnessError {
  constructor(message: string, code: string) {
    super(message, code)
    this.name = 'MediaStoreError'
  }
}

/** The one place a generated video may be written, and how to name it. */
export interface MediaStoreTarget {
  /** Absolute workspace root. */
  readonly root: string
  /** Absolute directory the file is written into. */
  readonly directory: string
  /**
   * Whether the root came from the working-directory service (true) or from
   * the session header (false). Reported so a caller can tell a live directory
   * from the creation-time one.
   */
  readonly fromWorkingDirectory: boolean
}

/**
 * The least a tool execution must expose for {@link resolveMediaStoreTarget}.
 *
 * Structural rather than the registry's own `ToolRunContext` so a test can
 * hand in a plain object; every field is optional because a tool is also
 * executed by tooling that composes no agent at all.
 */
export interface MediaStoreExec {
  readonly signal?: AbortSignal
  readonly agent?: {
    readonly session?: { readonly header?: { readonly cwd?: string } }
  }
}

/** The part of the harness `workingDirectory` service this module reads. */
export interface WorkingDirectoryLookup {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

/**
 * The session's current working directory, or undefined when nothing can name
 * one.
 *
 * @param ctx - anything with a `get` that returns the harness services.
 * @param exec - the tool execution naming the agent and its cancellation.
 * @returns an absolute directory, or undefined.
 */
export async function resolveSessionRoot(
  ctx: { get(name: string): unknown },
  exec: MediaStoreExec,
): Promise<{ root: string; fromWorkingDirectory: boolean } | undefined> {
  const agent = exec.agent
  if (agent !== undefined) {
    const service = ctx.get('workingDirectory') as WorkingDirectoryLookup | undefined
    if (service !== undefined && typeof service.ensure === 'function') {
      try {
        const root = await service.ensure(agent, exec.signal)
        if (typeof root === 'string' && root.trim() !== '') {
          return { root: path.resolve(root), fromWorkingDirectory: true }
        }
      } catch {
        // A working directory that cannot be produced (a moved project, an
        // inactive context) falls through to the header rather than failing the
        // write: the header still names where this session was created, which
        // is a usable answer.
      }
    }
    const headerCwd = agent.session?.header?.cwd
    if (typeof headerCwd === 'string' && headerCwd.trim() !== '') {
      return { root: path.resolve(headerCwd), fromWorkingDirectory: false }
    }
  }
  return undefined
}

/**
 * Resolve where a generated video will be written for one execution.
 *
 * @param ctx - host context, for the working-directory service.
 * @param exec - the tool execution.
 * @returns the resolved target.
 * @throws MediaStoreError when no workspace directory can be named at all.
 */
export async function resolveMediaStoreTarget(
  ctx: { get(name: string): unknown },
  exec: MediaStoreExec,
): Promise<MediaStoreTarget> {
  const resolved = await resolveSessionRoot(ctx, exec)
  if (resolved === undefined) {
    throw new MediaStoreError(
      'cannot write the generated video: this session has no working directory, and a generated '
      + 'video is written into the workspace so the preview panel can open it. Run the tool from a '
      + 'session opened on a project directory, or use the working-directory tool to select one, '
      + 'then retry.',
      'MINIMAX_VIDEO_NO_WORKSPACE',
    )
  }
  return {
    root: resolved.root,
    directory: path.join(resolved.root, GENERATED_VIDEO_DIR),
    fromWorkingDirectory: resolved.fromWorkingDirectory,
  }
}

/**
 * A filesystem-safe file name derived from values this module controls.
 *
 * Every part is generated here — a timestamp, the task id the service issued and
 * a fixed extension — and everything outside `[A-Za-z0-9._-]` is replaced, so a
 * task id carrying a separator cannot climb out of the directory. The caller
 * never supplies a path, which is what makes path traversal impossible rather
 * than merely filtered.
 *
 * @param taskId - upstream task id (or an equivalent generated identity).
 * @param extension - leading-dot extension, e.g. `.mp4`.
 * @param now - clock, injected so a test can pin the name.
 * @returns a leaf file name with no directory component.
 */
export function generatedVideoFileName(
  taskId: string,
  extension: string,
  now: number = Date.now(),
): string {
  const safeTask = taskId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 64)
  const safeExt = /^\.[A-Za-z0-9]{1,8}$/.test(extension) ? extension.toLowerCase() : '.mp4'
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  return 'minimax-' + stamp + '-' + (safeTask === '' ? 'video' : safeTask) + safeExt
}

/** A file extension for one media type, defaulting to .mp4. */
export function extensionForMediaType(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase()
  if (normalized === 'video/webm') return '.webm'
  if (normalized === 'video/quicktime') return '.mov'
  if (normalized === 'video/x-matroska') return '.mkv'
  return '.mp4'
}

/** Result of one committed write. */
export interface StoredVideo {
  /** Path relative to the workspace root, always POSIX-separated. */
  readonly relativePath: string
  /** Absolute path on this machine. */
  readonly absolutePath: string
  /** Exact byte length written. */
  readonly bytes: number
}

/**
 * Write one generated video into the workspace.
 *
 * @param target - the resolved target from {@link resolveMediaStoreTarget}.
 * @param data - the complete video bytes.
 * @param taskId - upstream task id, used to derive the file name.
 * @param mediaType - media type the response declared, for the extension.
 * @param now - clock, injected for a pinned test name.
 * @returns the workspace-relative path and its absolute counterpart.
 * @throws MediaStoreError for an empty or oversized payload.
 */
export async function writeGeneratedVideo(
  target: MediaStoreTarget,
  data: Uint8Array,
  options: { taskId: string; mediaType: string; now?: number },
): Promise<StoredVideo> {
  if (data.byteLength === 0) {
    throw new MediaStoreError(
      'cannot write the generated video: the service returned an empty file',
      'MINIMAX_VIDEO_EMPTY_FILE',
    )
  }
  if (data.byteLength > MAX_GENERATED_VIDEO_BYTES) {
    throw new MediaStoreError(
      'cannot write the generated video: it is ' + Math.round(data.byteLength / (1024 * 1024))
      + ' MB, above the ' + Math.round(MAX_GENERATED_VIDEO_BYTES / (1024 * 1024)) + ' MB limit this route stores',
      'MINIMAX_VIDEO_TOO_LARGE',
    )
  }
  const name = generatedVideoFileName(options.taskId, extensionForMediaType(options.mediaType), options.now)
  const absolutePath = path.join(target.directory, name)
  // Belt and braces: the name is built from a sanitized task id and a fixed
  // extension, and the joined path is still proven to sit directly inside the
  // directory before anything is created.
  if (path.dirname(absolutePath) !== target.directory || path.basename(absolutePath) !== name) {
    throw new MediaStoreError(
      'cannot write the generated video: the derived file name did not resolve inside the video directory',
      'MINIMAX_VIDEO_BAD_PATH',
    )
  }
  await fs.mkdir(target.directory, { recursive: true })
  await fs.writeFile(absolutePath, data)
  const relativePath = path.relative(target.root, absolutePath).split(path.sep).join('/')
  return { relativePath, absolutePath, bytes: data.byteLength }
}
