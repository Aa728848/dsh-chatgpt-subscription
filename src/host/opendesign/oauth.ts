/**
 * OpenDesign account sign-in: browser device authorization against the AMR API.
 *
 * This reimplements the official `vela login` flow over its public HTTP
 * contract, probed live on 2026-10-21 and cross-checked against upstream issue
 * nexu-io/open-design#8870:
 *
 * 1. `POST {apiBase}/cli/device-authorizations` with `{host, profile,
 *    cliVersion}` → 201 `{deviceId, userCode, status: 'pending', expiresAt,
 *    deviceSecret, activationUrl, pollIntervalSeconds}` (probed; the probe's
 *    201 body is quoted in docs/opendesign-line-plan.md);
 * 2. the user opens `activationUrl` (the Cloud console's CLI-activation page)
 *    and confirms the user code;
 * 3. `POST {apiBase}/cli/device-authorizations/{deviceId}/token` with
 *    `{deviceSecret}` polls: while pending it answers 200 with
 *    `status: 'pending'` and null keys (probed); on approval the same fields
 *    carry a `vela_ctrl_…` control key, an `sk-amr-…` runtime key and the
 *    user object (per #8870; the approved frame itself was not observed — the
 *    reader keys on key presence, never on a status string).
 *
 * Keys issued this way carry no published expiry: a revoked key is replaced by
 * signing in again, so there is no refresh chain here.
 *
 * @module dsh-chatgpt-subscription/opendesign-oauth
 */
import {
  AMR_API_BASE,
  DEVICE_AUTHORIZATIONS_PATH,
  DEVICE_CLIENT_NAME,
  DEVICE_CLIENT_PROFILE,
} from './types.ts'
import { sendJSON, trimBase } from './client.ts'
import type { OpenDesignOAuthCredentials } from './token-store.ts'

const DEFAULT_HTTP_TIMEOUT_MS = 30_000
/** Poll cadence floor when the service states none (its create answer says 2). */
const DEFAULT_POLL_INTERVAL_SECONDS = 2
/** Device authorization lifetime floor when the service states none. */
const DEFAULT_DEVICE_EXPIRES_SECONDS = 300

/** An auth failure with the HTTP facts a caller can judge. */
export class OpenDesignOAuthError extends Error {
  readonly status?: number
  readonly code?: string

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'OpenDesignOAuthError'
    this.status = options.status
    this.code = options.code
  }
}

/** One device authorization, as the create call returns it. */
export interface OpenDesignDeviceAuthorization {
  deviceId: string
  userCode: string
  activationUrl: string
  deviceSecret: string
  expiresAt: number
  pollIntervalSeconds: number
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function seconds(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function errorMessageOf(json: unknown, text: string): string {
  if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
    const record = json as Record<string, unknown>
    const error = record.error ?? record.message
    if (typeof error === 'string' && error !== '') return error.slice(0, 200)
    if (typeof error === 'object' && error !== null) {
      const nested = (error as Record<string, unknown>).message
      if (typeof nested === 'string' && nested !== '') return nested.slice(0, 200)
    }
  }
  return text.slice(0, 200)
}

/** Step 1: create one device authorization. */
export async function startOpenDesignDeviceAuth(
  fetchFn: typeof fetch,
  {
    apiBase = AMR_API_BASE,
    host,
    signal,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  }: { apiBase?: string; host: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<OpenDesignDeviceAuthorization> {
  const result = await sendJSON(fetchFn, `${trimBase(apiBase)}${DEVICE_AUTHORIZATIONS_PATH}`, {
    method: 'POST',
    body: { host, profile: DEVICE_CLIENT_PROFILE, cliVersion: DEVICE_CLIENT_NAME },
    signal,
    timeoutMs,
  })
  if (!result.ok) {
    throw new OpenDesignOAuthError(
      `Device authorization failed: HTTP ${result.status}${errorMessageOf(result.json, result.text) === '' ? '' : ` - ${errorMessageOf(result.json, result.text)}`}`,
      { status: result.status },
    )
  }
  const payload = typeof result.json === 'object' && result.json !== null && !Array.isArray(result.json)
    ? result.json as Record<string, unknown>
    : {}
  const deviceId = nonEmpty(payload.deviceId)
  const userCode = nonEmpty(payload.userCode)
  const activationUrl = nonEmpty(payload.activationUrl)
  const deviceSecret = nonEmpty(payload.deviceSecret)
  // Shape, not status (the 201 answer is only as good as the fields it carries).
  if (deviceId === undefined || userCode === undefined || activationUrl === undefined || deviceSecret === undefined) {
    throw new OpenDesignOAuthError('The service returned an incomplete device authorization', { status: result.status })
  }
  const expiresAtMs = Date.parse(String(payload.expiresAt ?? ''))
  return {
    deviceId,
    userCode,
    activationUrl,
    deviceSecret,
    expiresAt: Number.isFinite(expiresAtMs) && expiresAtMs > 0
      ? expiresAtMs
      : Date.now() + seconds(payload.expiresIn, DEFAULT_DEVICE_EXPIRES_SECONDS) * 1000,
    pollIntervalSeconds: seconds(payload.pollIntervalSeconds, DEFAULT_POLL_INTERVAL_SECONDS),
  }
}

/** One poll verdict: still waiting, or the issued credential pair. */
export type OpenDesignDevicePoll =
  | { pending: true }
  | { pending: false; credentials: OpenDesignOAuthCredentials }

/**
 * Step 3: one poll of the device grant.
 *
 * Completion is read from the payload's SHAPE: `runtimeKey`/`controlKey`
 * present means approved, whatever `status` says; a non-pending status with no
 * keys is a refusal (denied or expired), reported with the service's own words.
 */
export async function pollOpenDesignDevice(
  fetchFn: typeof fetch,
  authorization: Pick<OpenDesignDeviceAuthorization, 'deviceId' | 'deviceSecret'>,
  {
    apiBase = AMR_API_BASE,
    signal,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  }: { apiBase?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OpenDesignDevicePoll> {
  const result = await sendJSON(
    fetchFn,
    `${trimBase(apiBase)}${DEVICE_AUTHORIZATIONS_PATH}/${encodeURIComponent(authorization.deviceId)}/token`,
    { method: 'POST', body: { deviceSecret: authorization.deviceSecret }, signal, timeoutMs },
  )
  const payload = typeof result.json === 'object' && result.json !== null && !Array.isArray(result.json)
    ? result.json as Record<string, unknown>
    : {}
  if (result.ok) {
    const runtimeKey = nonEmpty(payload.runtimeKey)
    const controlKey = nonEmpty(payload.controlKey)
    if (runtimeKey !== undefined && controlKey !== undefined) {
      const user = typeof payload.user === 'object' && payload.user !== null && !Array.isArray(payload.user)
        ? payload.user as Record<string, unknown>
        : undefined
      return {
        pending: false,
        credentials: {
          kind: 'oauth',
          controlKey,
          runtimeKey,
          addedAt: Date.now(),
          ...(user === undefined ? {} : {
            user: {
              ...(nonEmpty(user.id) === undefined ? {} : { id: nonEmpty(user.id) }),
              ...(nonEmpty(user.email) === undefined ? {} : { email: nonEmpty(user.email) }),
              ...(nonEmpty(user.name) === undefined ? {} : { name: nonEmpty(user.name) }),
              ...(nonEmpty(user.plan) === undefined ? {} : { plan: nonEmpty(user.plan) }),
            },
          }),
        },
      }
    }
    const status = nonEmpty(payload.status) ?? ''
    if (status === 'pending' || status === '') return { pending: true }
    throw new OpenDesignOAuthError(`The authorization was ${status}.`, { status: result.status, code: status })
  }
  const detail = errorMessageOf(result.json, result.text)
  throw new OpenDesignOAuthError(
    detail === '' ? `Authorization poll failed: HTTP ${result.status}` : detail,
    { status: result.status },
  )
}

/** One login flow, as the settings card renders it. */
export type OpenDesignLoginStatus = 'idle' | 'pending' | 'complete' | 'failed' | 'cancelled'

export interface OpenDesignLoginFlow {
  id: string
  status: OpenDesignLoginStatus
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalSeconds: number
  error: string
  accountAlias: string
}

interface InternalFlow {
  dto: OpenDesignLoginFlow
  deviceId: string
  deviceSecret: string
  nextPollAt: number
  polling: boolean
}

export interface OpenDesignLoginOptions {
  fetchFn: typeof fetch
  /** AMR control-plane base; a test seam and a deployment override. */
  apiBase?: string
  /** This machine's name, recorded on the authorization the console lists. */
  host(): string
  /** Persist a newly signed-in account; throws make the flow fail. */
  onLogin(credentials: OpenDesignOAuthCredentials): Promise<void>
  logger?: { warn(message: string, ...args: unknown[]): void }
}

/**
 * One device-authorization sign-in at a time.
 *
 * Polling is driven by the card (`GET /login/status`): each request makes at
 * most one AMR call, and only after the advertised interval has elapsed. A host
 * restart therefore loses the pending flow rather than keeping a poll loop
 * alive with no reader — the same contract the sibling lines use.
 */
export class OpenDesignLoginManager {
  private flow: InternalFlow | null = null
  private sequence = 0

  constructor(private readonly options: OpenDesignLoginOptions) {}

  /** Start a new flow, cancelling any previous one. */
  async begin({ signal }: { signal?: AbortSignal } = {}): Promise<OpenDesignLoginFlow> {
    // A second sign-in replaces the first; the old flow must reach a terminal
    // state so a late poll from it cannot resurrect an abandoned attempt.
    if (this.flow !== null && this.flow.dto.status === 'pending') this.flow.dto.status = 'cancelled'
    const device = await startOpenDesignDeviceAuth(this.options.fetchFn, {
      ...(this.options.apiBase === undefined ? {} : { apiBase: this.options.apiBase }),
      host: this.options.host(),
      ...(signal === undefined ? {} : { signal }),
    })
    const id = `opendesign-${Date.now().toString(36)}-${(this.sequence += 1)}`
    const now = Date.now()
    const flow: InternalFlow = {
      dto: {
        id,
        status: 'pending',
        userCode: device.userCode,
        verificationUri: device.activationUrl,
        expiresAt: device.expiresAt,
        intervalSeconds: device.pollIntervalSeconds,
        error: '',
        accountAlias: '',
      },
      deviceId: device.deviceId,
      deviceSecret: device.deviceSecret,
      nextPollAt: now + device.pollIntervalSeconds * 1000,
      polling: false,
    }
    this.flow = flow
    return { ...flow.dto }
  }

  /** The latest flow, or null when this process never started one. */
  current(): OpenDesignLoginFlow | null {
    return this.flow === null ? null : { ...this.flow.dto }
  }

  /**
   * Advance one flow and return its state.
   *
   * A flow the caller does not name is not advanced: two cards (or a stale one)
   * cannot spend each other's polls.
   */
  async status(id: string, { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<OpenDesignLoginFlow> {
    const flow = this.flow
    if (flow === null || flow.dto.id !== id) {
      throw new OpenDesignOAuthError('This sign-in flow is no longer active', { code: 'login_not_found' })
    }
    if (flow.dto.status !== 'pending') return { ...flow.dto }
    if (Date.now() >= flow.dto.expiresAt) {
      flow.dto.status = 'failed'
      flow.dto.error = 'The device authorization expired. Start sign-in again.'
      return { ...flow.dto }
    }
    if (flow.polling || Date.now() < flow.nextPollAt) return { ...flow.dto }
    flow.polling = true
    try {
      let result: OpenDesignDevicePoll
      try {
        result = await pollOpenDesignDevice(this.options.fetchFn, flow, {
          ...(this.options.apiBase === undefined ? {} : { apiBase: this.options.apiBase }),
          ...(signal === undefined ? {} : { signal }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        })
      } catch (error) {
        // A refusal with a status word (denied/expired) or a 404/410 (the
        // authorization is gone) is terminal. Anything else — a transport blip
        // or a server 5xx — is not a verdict on the user's browser
        // confirmation: keep polling until the authorization itself expires.
        const terminal = error instanceof OpenDesignOAuthError
          && (error.code !== undefined || error.status === 404 || error.status === 410)
        if (terminal) {
          flow.dto.status = 'failed'
          flow.dto.error = error instanceof Error ? error.message : String(error)
          return { ...flow.dto }
        }
        flow.nextPollAt = Date.now() + flow.dto.intervalSeconds * 1000
        flow.dto.error = error instanceof Error ? error.message : String(error)
        return { ...flow.dto }
      }
      if (result.pending) {
        flow.nextPollAt = Date.now() + flow.dto.intervalSeconds * 1000
        return { ...flow.dto }
      }
      // Cancellation (or a newer sign-in) can land while the poll is in flight;
      // a late success must not resurrect an abandoned flow.
      if (this.flow !== flow || flow.dto.status !== 'pending') return { ...flow.dto }
      await this.options.onLogin(result.credentials)
      flow.dto.status = 'complete'
      flow.dto.accountAlias = result.credentials.user?.name ?? result.credentials.user?.email ?? 'OpenDesign'
      return { ...flow.dto }
    } catch (error) {
      flow.dto.status = 'failed'
      flow.dto.error = error instanceof Error ? error.message : String(error)
      this.options.logger?.warn('[opendesign] sign-in failed: %s', flow.dto.error)
      return { ...flow.dto }
    } finally {
      flow.polling = false
    }
  }

  /** Abandon one flow; a late browser confirmation is then ignored. */
  cancel(id: string): boolean {
    const flow = this.flow
    if (flow === null || flow.dto.id !== id || flow.dto.status !== 'pending') return false
    flow.dto.status = 'cancelled'
    flow.dto.error = ''
    return true
  }

  /** Mark every flow cancelled for teardown. */
  dispose(): void {
    if (this.flow !== null && this.flow.dto.status === 'pending') {
      this.flow.dto.status = 'cancelled'
    }
  }
}
