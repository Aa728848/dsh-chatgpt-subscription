/**
 * Wire half of the MiniMax Code daily check-in.
 *
 * Everything in this file is measured against, or ported from, the official
 * client's own open source (`MiniMax-AI/minimax-code`, MIT):
 * `packages/tui/src/checkin/http-gateway.ts` does the two check-in calls and
 * `packages/tui/src/runtime/public-gateway.ts` builds the request. The wire
 * shape was additionally verified live against the CN deployment with this
 * machine's own credential (see the 0.2.0-rc.1-era probe notes in the
 * changelog): `GET signin/status` and `POST signin/claim` answer exactly the
 * shapes validated below, and a duplicate claim answers
 * `claim_result: 2` (AlreadyClaimed) rather than an error.
 *
 * The `yy` / `x-timestamp` / `x-signature` headers are the same first-party
 * attribution literals this package's `types.ts` product-token note discusses.
 * The official source's own comment calls them wire-protocol constants that
 * are "not credentials or a security boundary" — authorization is the Bearer
 * token. Unlike the quota read (where they are optional and stay off by
 * default), the check-in gateway refuses requests without them, so this
 * feature cannot exist without sending them; that trade is recorded in the
 * changelog and was made explicitly, not by default. The User-Agent stays the
 * plugin's own honest one — it is NOT part of the signed surface.
 */

import { createHash } from 'node:crypto'
import type { MinimaxCodeRegion } from '../../shared/minimax-code-contracts.ts'
import { USER_AGENT } from './types.ts'

/** Activity status surface; answers whether today is claimable or claimed. */
export const SIGNIN_STATUS_PATH = '/minimax-cloud/api/v1/signin/status'
/** Check-in surface; credits are granted by posting here once a day. */
export const SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim'
/** Account identity surface; resolves the realUserID the query string needs. */
export const USER_INFO_PATH = '/v1/api/user/info'

/** Day status values the panel reports. Mirrors the official SigninDayStatus. */
export const SIGNIN_DAY_UPCOMING = 1
export const SIGNIN_DAY_CLAIMABLE = 2
export const SIGNIN_DAY_CLAIMED = 3
export const SIGNIN_DAY_DISABLED = 4

/** Claim outcomes the service reports. Mirrors the official SigninClaimResult. */
export const SIGNIN_CLAIM_FRESH = 1
export const SIGNIN_CLAIM_ALREADY = 2

export const CHECKIN_TIMEOUT_MS = 30_000

/**
 * Salt the first-party clients mix into `x-signature`.
 *
 * Inline in the official client's public bundle and in its open-source CLI
 * (`public-gateway.ts`); the comment there calls it a wire-protocol constant,
 * since changing it needs a coordinated server-side rollout.
 */
const SIGNATURE_SALT = 'I*7Cf%WZ#S&%1RlZJ&C2'

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

/** Origin the official client uses for this surface, per region. */
export function checkinGatewayOrigin(region: MinimaxCodeRegion): string {
  return region === 'cn' ? 'https://agent.minimaxi.com' : 'https://agent.minimax.io'
}

export interface SigninDayItem {
  day_no: number
  points: number
  bonus_points?: number
  status: number
  is_today: boolean
}

export interface SigninPanel {
  scene: number
  days: SigninDayItem[]
}

export interface ClaimSigninData {
  claim_id: string
  claim_result: number
  day_no: number
  points: number
  expire_at_ms: number
  panel: SigninPanel
}

/** Identity the check-in needs beyond the access token. */
export interface MinimaxCodeAccountIdentity {
  realUserID: string
  userName?: string
  subUserName?: string
  userEmail?: string
}

const DAY_STATUSES = new Set([SIGNIN_DAY_UPCOMING, SIGNIN_DAY_CLAIMABLE, SIGNIN_DAY_CLAIMED, SIGNIN_DAY_DISABLED])
const CLAIM_RESULTS = new Set([SIGNIN_CLAIM_FRESH, SIGNIN_CLAIM_ALREADY])
const PANEL_SCENES = new Set([0, 1, 2, 3, 4])

/**
 * Validate one panel response. Ported from the official
 * `validateSigninPanel`: exactly seven days, day numbers 1..7 without
 * repeats, at most one claimable and at most one "today". A panel that fails
 * this is a wire surprise, and treating it as "nothing to do" would silently
 * skip the day, so validation throws.
 */
export function validateSigninPanel(value: unknown): SigninPanel {
  const panel = value as Partial<SigninPanel> | null
  const days = panel?.days
  const dayNumbers = new Set<number>()
  let claimableDays = 0
  let todayDays = 0
  const validDays = Array.isArray(days) && days.length === 7 && days.every((day) => {
    if (day === null || typeof day !== 'object') return false
    const item = day as Partial<SigninDayItem>
    const dayNo = item.day_no
    if (typeof dayNo !== 'number' || !Number.isInteger(dayNo) || dayNo < 1 || dayNo > 7 || dayNumbers.has(dayNo)) return false
    if (typeof item.points !== 'number' || !Number.isFinite(item.points) || item.points < 0) return false
    if (item.bonus_points !== undefined
      && (typeof item.bonus_points !== 'number' || !Number.isFinite(item.bonus_points) || item.bonus_points < 0)) return false
    if (typeof item.is_today !== 'boolean' || !DAY_STATUSES.has(item.status as number)) return false
    dayNumbers.add(dayNo)
    if (item.status === SIGNIN_DAY_CLAIMABLE) claimableDays += 1
    if (item.is_today === true) todayDays += 1
    return true
  })
  if (panel === null || typeof panel !== 'object' || !PANEL_SCENES.has(panel.scene as number) || !validDays
    || claimableDays > 1 || todayDays > 1) {
    throw new Error('Invalid sign-in panel')
  }
  return panel as SigninPanel
}

/** Validate one claim response. Ported from the official `validateClaimSigninData`. */
export function validateClaimSigninData(value: unknown): ClaimSigninData {
  const data = value as Partial<ClaimSigninData> | null
  const valid = data !== null && typeof data === 'object'
    && typeof data.claim_id === 'string' && data.claim_id.length > 0
    && CLAIM_RESULTS.has(data.claim_result as number)
    && Number.isInteger(data.day_no) && (data.day_no ?? 0) >= 1 && (data.day_no ?? 8) <= 7
    && typeof data.points === 'number' && Number.isFinite(data.points) && data.points >= 0
    && typeof data.expire_at_ms === 'number' && Number.isFinite(data.expire_at_ms)
  if (!valid) throw new Error('Invalid sign-in claim response')
  return { ...(data as ClaimSigninData), panel: validateSigninPanel(data.panel) }
}

/**
 * The consecutive-claimed count ending today, from one panel.
 *
 * Ported from the official `getCurrentSigninStreak`: when today is claimed it
 * counts; when today is still claimable the streak up to yesterday is what a
 * claim would extend, so that is what the card shows.
 */
export function currentSigninStreak(days: readonly SigninDayItem[]): number {
  const sorted = [...days].sort((left, right) => left.day_no - right.day_no)
  const todayIndex = sorted.findIndex((day) => day.is_today)
  if (todayIndex < 0) return 0
  const todayStatus = sorted[todayIndex]?.status
  let index = todayStatus === SIGNIN_DAY_CLAIMED ? todayIndex : todayStatus === SIGNIN_DAY_CLAIMABLE ? todayIndex - 1 : -1
  if (index < 0) return 0
  let streak = 0
  for (; index >= 0; index -= 1) {
    if (sorted[index]?.status !== SIGNIN_DAY_CLAIMED) break
    streak += 1
  }
  return streak
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * One signed request, built the way the official CLI builds it
 * (`createPublicGatewayRequest`).
 *
 * The query constants (`device_platform=web`, `is_desktop=1`, `client=mcode`,
 * `browser_name=mcode`, `device_id=0`) are the gateway's protocol vocabulary
 * for this surface, copied verbatim; `desktop_version` reports THIS plugin's
 * version, because it is the version field of the client making the request
 * and inventing the official app's number would be the one genuinely false
 * statement available here. `yy` hashes the millisecond clock while
 * `x-timestamp` / `x-signature` use whole seconds — both spellings are in
 * the official source and the mismatch is deliberate, not a typo to fix.
 */
function createCheckinRequest(input: {
  origin: string
  path: string
  accessToken: string
  realUserID: string
  appVersion: string
  language: string
  nowMs: number
  body?: string
}): { url: URL; headers: Record<string, string> } {
  const url = new URL(input.origin + input.path)
  url.search = new URLSearchParams({
    device_platform: 'web',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    is_desktop: '1',
    desktop_version: input.appVersion,
    unix: String(input.nowMs),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: input.language,
    lang: input.language,
    device_id: '0',
    os_name: process.platform,
    browser_name: 'mcode',
    user_id: input.realUserID,
    client: 'mcode',
  }).toString()
  const second = Math.floor(input.nowMs / 1000)
  const pathWithSearch = `${url.pathname}${url.search}`
  const signatureBody = input.body ?? ''
  const yyBody = input.body ?? '{}'
  return {
    url,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${input.accessToken}`,
      yy: md5(`${encodeURIComponent(pathWithSearch)}_${yyBody}${md5(String(input.nowMs))}ooui`),
      'x-timestamp': String(second),
      'x-signature': md5(`${second}${SIGNATURE_SALT}${signatureBody}`),
    },
  }
}

/**
 * The identity call uses the matrix account surface's own query vocabulary
 * (`device_platform=mcode`, no `is_desktop`/`desktop_version`) — the two
 * surfaces spell the same device differently in the official client, and the
 * difference is load-bearing: mixing them is what an "invalid access token"
 * answer means when the token itself is fine.
 */
function createIdentityRequest(input: {
  origin: string
  accessToken: string
  language: string
  nowMs: number
}): { url: URL; headers: Record<string, string> } {
  const url = new URL(input.origin + USER_INFO_PATH)
  url.search = new URLSearchParams({
    device_platform: 'mcode',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    unix: String(input.nowMs),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: input.language,
    lang: input.language,
    device_id: '0',
    os_name: process.platform,
    browser_name: 'mcode',
    user_id: '0',
    client: 'mcode',
  }).toString()
  const second = Math.floor(input.nowMs / 1000)
  const pathWithSearch = `${url.pathname}${url.search}`
  return {
    url,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      authorization: `Bearer ${input.accessToken}`,
      yy: md5(`${encodeURIComponent(pathWithSearch)}_{}${md5(String(input.nowMs))}ooui`),
      'x-timestamp': String(second),
      'x-signature': md5(`${second}${SIGNATURE_SALT}`),
    },
  }
}

export interface CheckinHttpOptions {
  fetchFn?: typeof fetch
  /** Clock injection for tests. */
  nowMs?: () => number
  /** `desktop_version` the request reports; the plugin version in production. */
  appVersion?: string
  signal?: AbortSignal
}

export class MinimaxCodeCheckinHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'MinimaxCodeCheckinHttpError'
  }
}

function languageFor(region: MinimaxCodeRegion): string {
  return region === 'cn' ? 'zh' : 'en'
}

/**
 * Resolve the account's realUserID (and display fields) through the identity
 * surface. The check-in query string needs realUserID and the OAuth document
 * does not carry it, so it is resolved once per scheduler pass and cached in
 * the check-in state afterwards.
 */
export async function fetchAccountIdentity(
  accessToken: string,
  region: MinimaxCodeRegion,
  options: CheckinHttpOptions = {},
): Promise<MinimaxCodeAccountIdentity> {
  const fetchFn = options.fetchFn ?? fetch
  const nowMs = (options.nowMs ?? Date.now)()
  const request = createIdentityRequest({
    origin: checkinGatewayOrigin(region),
    accessToken,
    language: languageFor(region),
    nowMs,
  })
  const response = await fetchFn(request.url, {
    method: 'GET',
    headers: request.headers,
    signal: options.signal ?? AbortSignal.timeout(CHECKIN_TIMEOUT_MS),
  })
  if (response.status === 401 || response.status === 403) {
    throw new MinimaxCodeCheckinHttpError(`identity request rejected with HTTP ${response.status}`, response.status)
  }
  const parsed = await response.json().catch(() => null)
  if (!response.ok || !isRecord(parsed)) {
    throw new MinimaxCodeCheckinHttpError(`identity request failed with HTTP ${response.status}`, response.status)
  }
  const data = isRecord(parsed.data) ? parsed.data : undefined
  const userInfo = (isRecord(data?.userInfo) ? data?.userInfo : undefined)
    ?? (isRecord(data?.user_info) ? data?.user_info : undefined)
    ?? (isRecord(parsed.userInfo) ? parsed.userInfo : undefined)
    ?? (isRecord(parsed.user_info) ? parsed.user_info : undefined)
  const realUserID = readString(userInfo, 'realUserID', 'real_user_id')
  if (realUserID === undefined) {
    throw new MinimaxCodeCheckinHttpError('identity response carried no realUserID', response.status)
  }
  return {
    realUserID,
    ...(readString(userInfo, 'userName', 'name', 'user_name') !== undefined
      ? { userName: readString(userInfo, 'userName', 'name', 'user_name') } : {}),
    ...(readString(userInfo, 'subUserName', 'sub_user_name') !== undefined
      ? { subUserName: readString(userInfo, 'subUserName', 'sub_user_name') } : {}),
    ...(readString(userInfo, 'userEmail', 'email', 'userMail', 'user_email') !== undefined
      ? { userEmail: readString(userInfo, 'userEmail', 'email', 'userMail', 'user_email') } : {}),
  }
}

/** One status or claim call against the check-in surface. */
async function checkinCall(
  path: string,
  method: 'GET' | 'POST',
  accessToken: string,
  realUserID: string,
  region: MinimaxCodeRegion,
  options: CheckinHttpOptions,
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch
  const nowMs = (options.nowMs ?? Date.now)()
  const body = method === 'POST' ? '{}' : undefined
  const request = createCheckinRequest({
    origin: checkinGatewayOrigin(region),
    path,
    accessToken,
    realUserID,
    appVersion: options.appVersion ?? '0.0.0',
    language: languageFor(region),
    nowMs,
    ...(body === undefined ? {} : { body }),
  })
  const response = await fetchFn(request.url, {
    method,
    headers: request.headers,
    ...(body === undefined ? {} : { body }),
    signal: options.signal ?? AbortSignal.timeout(CHECKIN_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let parsed: Record<string, unknown> | null = null
  try {
    const value = JSON.parse(text) as unknown
    parsed = isRecord(value) ? value : null
  } catch {
    parsed = null
  }
  if (!response.ok) {
    throw new MinimaxCodeCheckinHttpError(
      `daily check-in request failed with HTTP ${response.status}${parsed === null ? '' : `: ${text.slice(0, 200)}`}`,
      response.status,
    )
  }
  const baseResp = isRecord(parsed?.base_resp) ? parsed.base_resp : undefined
  const statusCode = typeof baseResp?.status_code === 'number' ? baseResp.status_code : undefined
  if (statusCode !== undefined && statusCode !== 0) {
    throw new MinimaxCodeCheckinHttpError(
      typeof baseResp?.status_msg === 'string' && baseResp.status_msg !== '' ? baseResp.status_msg : 'daily check-in request rejected',
      response.status,
    )
  }
  if (parsed === null || parsed.data === null || parsed.data === undefined) {
    throw new MinimaxCodeCheckinHttpError('daily check-in response data is missing', response.status)
  }
  return parsed.data
}

/** Read the seven-day panel; throws on transport, HTTP, or shape failures. */
export async function fetchSigninPanel(
  accessToken: string,
  realUserID: string,
  region: MinimaxCodeRegion,
  options: CheckinHttpOptions = {},
): Promise<SigninPanel> {
  return validateSigninPanel(await checkinCall(SIGNIN_STATUS_PATH, 'GET', accessToken, realUserID, region, options))
}

/** Claim today's credit; the response carries the fresh panel. */
export async function claimSignin(
  accessToken: string,
  realUserID: string,
  region: MinimaxCodeRegion,
  options: CheckinHttpOptions = {},
): Promise<ClaimSigninData> {
  return validateClaimSigninData(await checkinCall(SIGNIN_CLAIM_PATH, 'POST', accessToken, realUserID, region, options))
}
