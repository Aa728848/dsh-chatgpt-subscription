import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MinimaxCodeAdapter,
  classifyMinimaxFailure,
} from '../src/host/minimax-code/adapter.ts'
import {
  MinimaxCodeAccountPool,
  parseMinimaxCodePoolData,
} from '../src/host/minimax-code/account-pool.ts'
import {
  MinimaxCodeCredentialStore,
  pluginCredentialPath,
  type MinimaxCodeCredentials,
} from '../src/host/minimax-code/token-store.ts'
import { PROVIDER_ID, PROVIDER_NAME } from '../src/host/minimax-code/types.ts'
import { resetRefreshRejections } from '../src/host/minimax-code/oauth.ts'

/**
 * The 429 that used to leave the pool untouched.
 *
 * This line was the only one in the package that had an account pool and did nothing
 * with a refused account: the non-2xx branch classified the failure and threw, never
 * touching the pool, so once one account's Token Plan ran out EVERY later request kept
 * being served by that same account — the pool selected it each time and had no way to
 * learn it had been refused. Every sibling line cools the account first
 * (command-code:513-518, ollama:318-322, workbuddy:376-388, kimi-code:834-863,
 * responses-client:280-292, claude:761-774); these cases pin that the same reaction
 * happens here now, and pin the two places it must NOT happen.
 *
 * No network and no real credential: the transport is an injected fetchFn and the pool
 * is backed by an in-memory document.
 */

let dshHome = ''
let minimaxHome = ''

beforeEach(async () => {
  resetRefreshRejections()
  dshHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-minimax-429-'))
  // An EMPTY MiniMax home: no case may read the developer's real ~/.minimax.
  minimaxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-minimax-429-native-'))
  process.env.DSH_HOME = dshHome
  process.env.MINIMAX_HOME = minimaxHome
})

afterEach(async () => {
  resetRefreshRejections()
  delete process.env.DSH_HOME
  delete process.env.MINIMAX_HOME
  vi.restoreAllMocks()
  delete process.env.DSH_MINIMAX_CODE_MAX_IMAGE_BYTES
  // Named files, then the directories deepest-first. A recursive delete walks
  // through a junction and destroys its target, so it is not used here.
  await fs.rm(pluginCredentialPath(), { force: true }).catch(() => undefined)
  // The Files API id cache, written by the upload case below, is named rather
  // than swept: it lives under the temporary DSH_HOME and must not outlive it.
  await fs.rm(path.join(dshHome, 'storages', 'minimax-code-files.json'), { force: true }).catch(() => undefined)
  // The desktop app's own sign-in file, which the native cases below write and
  // the pool then rotates in place. Named rather than swept, for the same reason.
  for (const region of ['cn', 'global']) {
    await fs.rm(path.join(minimaxHome, 'auth', 'prod', region, 'mcode-public', 'auth.json'), { force: true }).catch(() => undefined)
  }
  for (const directory of [
    path.join(minimaxHome, 'auth', 'prod', 'cn', 'mcode-public'),
    path.join(minimaxHome, 'auth', 'prod', 'global', 'mcode-public'),
    path.join(minimaxHome, 'auth', 'prod', 'cn'),
    path.join(minimaxHome, 'auth', 'prod', 'global'),
    path.join(minimaxHome, 'auth', 'prod'),
    path.join(minimaxHome, 'auth'),
    path.join(dshHome, 'storages'),
    dshHome,
    minimaxHome,
  ]) {
    await fs.rmdir(directory).catch(() => undefined)
  }
})

/** A pool document in memory, so no DPAPI helper and no disk file is involved. */
class PoolBackend {
  private data: unknown = null
  async load() { return this.data === null ? null : parseMinimaxCodePoolData(JSON.parse(JSON.stringify(this.data))) }
  async save(data: unknown) { this.data = JSON.parse(JSON.stringify(data)) }
  async clear() { this.data = null }
}

/** One plugin-owned credential, comfortably valid, exactly as the line issues them. */
function credential(n: number): MinimaxCodeCredentials {
  return {
    accessToken: 'at-' + n,
    refreshToken: 'rt-' + n,
    tokenType: 'Bearer',
    clientId: 'mcode-public',
    scopes: ['agent.default'],
    audience: 'agent-backend',
    expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    generation: 1,
    loginEpoch: 'signin-' + n,
    buildEnv: 'prod',
    region: 'cn',
    recordKey: null,
    source: 'file',
  }
}

async function writePluginCredential(value: MinimaxCodeCredentials): Promise<void> {
  const file = pluginCredentialPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

/** A pool of two signed-in accounts, the only shape a rotation needs. */
async function twoAccountPool(): Promise<{ pool: MinimaxCodeAccountPool; firstId: string; secondId: string }> {
  const store = new MinimaxCodeCredentialStore('cn')
  const pool = new MinimaxCodeAccountPool({ store, backend: new PoolBackend() as never })
  const first = await pool.addAccount(credential(1))
  const second = await pool.addAccount(credential(2))
  return { pool, firstId: first.id, secondId: second.id }
}

/** A pool of exactly ONE account: a 429 here has nowhere left to rotate to. */
async function oneAccountPool(): Promise<{ pool: MinimaxCodeAccountPool; firstId: string }> {
  const store = new MinimaxCodeCredentialStore('cn')
  const pool = new MinimaxCodeAccountPool({ store, backend: new PoolBackend() as never })
  const first = await pool.addAccount(credential(1))
  return { pool, firstId: first.id }
}

/** A 200 SSE answer carrying one text delta, the shape an adapter-level case needs. */
function answerStream(text: string): Response {
  return new Response(
    'data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }) + '\n\n'
    + 'data: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) + '\n\n'
    + 'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) + '\n\n'
    + 'data: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/**
 * The bearer token one request presented.
 *
 * Read through `Headers` because the line sends `authorization` in lower case and
 * which account served a request is the whole subject of the cases below.
 */
function bearerOf(init: RequestInit | undefined): string {
  return new Headers(init?.headers).get('authorization') ?? ''
}

/** One non-2xx answer, and nothing else. */
function refusingFetch(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })) as unknown as typeof fetch
}

/** One SSE stream whose only event is an in-band failure, before any output. */
function inBandErrorFetch(error: unknown): typeof fetch {
  return vi.fn(async () => new Response(
    'data: ' + JSON.stringify({ type: 'error', error }) + '\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )) as unknown as typeof fetch
}

const request = { provider: PROVIDER_ID, model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }] }

/** Drain one stream, returning what it threw (or null when it completed). */
async function failureOf(adapter: MinimaxCodeAdapter): Promise<Error | null> {
  try {
    for await (const _chunk of adapter.stream(request as never)) { /* drain */ }
    return null
  } catch (error) {
    return error as Error
  }
}

/** The stored cooldown one failed request left on one account. */
async function cooldownOf(
  pool: MinimaxCodeAccountPool,
  accountId: string,
): Promise<{ until?: number; reason?: string }> {
  const account = (await pool.read()).accounts.find((entry) => entry.id === accountId)
  return {
    ...(account?.cooldownUntil === undefined ? {} : { until: account.cooldownUntil }),
    ...(account?.cooldownReason === undefined ? {} : { reason: account.cooldownReason }),
  }
}
/**
 * The token endpoint, called by the 401/403 recovery rather than by the request.
 *
 * The recovery loop renews once on a 401 OR on a credential-class 403 before the
 * response is classified, because the status alone cannot say which of the two a
 * 403 is. These cases therefore have to answer the renewal as well, and answering
 * it is the honest way to see what the recovery spent.
 *
 * The one 403 that does NOT get it is the one whose own body names a spent window:
 * a window is spent whether the token is fresh or rotated, so renewing it bought
 * nothing and cost a round trip (and, for a native account, overwrote the desktop
 * app's own auth.json). The cases pinning that count these calls at zero rather than
 * merely not needing them.
 */
function isTokenEndpoint(input: RequestInfo | URL): boolean {
  return String(input).includes('/oauth2/token')
}

/** One accepted refresh, in the shape the token endpoint answers. */
function tokenExchange(accessToken: string, refreshToken: string): Response {
  return Response.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3_600,
    token_type: 'Bearer',
  })
}

/** One region's native auth.json, in the desktop app's own shape. */
async function writeNativeCredential(region: 'cn' | 'global', value: {
  accessToken?: string
  refreshToken?: string
  expiresAtMs?: number
  recordKey?: string
} = {}): Promise<string> {
  const dir = path.join(minimaxHome, 'auth', 'prod', region, 'mcode-public')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'auth.json')
  await fs.writeFile(file, JSON.stringify({
    schemaVersion: 1,
    records: {
      [value.recordKey ?? 'record-key-hash']: {
        clientId: 'mcode-public',
        accessToken: value.accessToken ?? 'at-native',
        refreshToken: value.refreshToken ?? 'rt-native',
        expiresAtMs: value.expiresAtMs ?? Date.now() + 3_600_000,
        region,
      },
    },
  }), 'utf8')
  return file
}

describe('a 429 the pool never heard about', () => {
  it('cools the exhausted account and takes it out of rotation', async () => {
    const { pool, firstId, secondId } = await twoAccountPool()
    const adapter = new MinimaxCodeAdapter({} as never, {
      fetchFn: refusingFetch(429, { base_resp: { status_code: 2013, status_msg: '当前套餐额度已耗尽' } }),
      accountPool: pool,
    })

    // Before the failure the primary is what serves the turn, which is the point:
    // the pool WAS selecting this account every time and had no way to learn it had
    // been refused.
    expect((await pool.getEffectiveCredential(undefined, fetch)).account.id).toBe(firstId)

    const thrown = await failureOf(adapter)
    expect(thrown?.message).toMatch(/quota is exhausted/)

    const cooled = await cooldownOf(pool, firstId)
    expect(cooled.until).toBeGreaterThan(Date.now())
    expect(cooled.reason).toBe(PROVIDER_NAME + ' 429')

    // The whole defect in one assertion: a spent plan window stays spent, so the
    // account is out of rotation, and the selection says so rather than handing
    // back the account the service just refused.
    //
    // No account can serve by now, and this stub is why: it refuses EVERY account,
    // and the request above rotates onto the second one exactly as the sibling
    // lines do, so that one is legitimately refused and cooled too. What a second
    // account that CAN still answer looks like is the rotation case below; this
    // case is about what the refusal leaves behind in the pool.
    await expect(pool.getEffectiveCredential(undefined, fetch)).rejects.toThrow(/配额限制|冷却/)
  })

  it('sizes the cooldown a plain 429 takes from its Retry-After header', async () => {
    const { pool, firstId } = await twoAccountPool()
    const adapter = new MinimaxCodeAdapter({} as never, {
      fetchFn: refusingFetch(429, { message: 'too many requests' }, { 'retry-after': '90' }),
      accountPool: pool,
    })

    const before = Date.now()
    expect(await failureOf(adapter)).not.toBeNull()
    const after = Date.now()

    // The interval, not a sleep: markCooldown stamps `now + durationMs` and the
    // shared core clamps the low end at 10s (common/account-pool.ts:549).
    const cooled = await cooldownOf(pool, firstId)
    expect(cooled.until).toBeGreaterThanOrEqual(before + 90_000)
    expect(cooled.until).toBeLessThanOrEqual(after + 90_000)
  })

  it('cools a plain rate limit for the shared 15-minute default, and keeps it retryable', async () => {
    const { pool, firstId } = await twoAccountPool()
    const adapter = new MinimaxCodeAdapter({} as never, {
      fetchFn: refusingFetch(429, { errorCode: 1002, errorReason: 'rate_limit_exceeded' }),
      accountPool: pool,
    })

    const before = Date.now()
    const thrown = await failureOf(adapter)

    // The judgment, stated: every sibling line cools on ANY 429 — the wording does
    // not gate the cooldown (command-code:513, ollama:318, workbuddy:378,
    // responses-client:280). Back-pressure is short-lived, 15 minutes is the length
    // all of them agree on, and leaving an account IN rotation while the service is
    // refusing it is what produced the bug. What the wording DOES decide is
    // retryability: this one must stay RATE_LIMIT so the bounded backoff still runs,
    // and must NOT be read as a spent plan.
    expect((thrown as { code?: string }).code).toBe('RATE_LIMIT')
    expect(thrown?.message).toMatch(/rate limited or overloaded/)
    const cooled = await cooldownOf(pool, firstId)
    expect(cooled.until).toBeGreaterThanOrEqual(before + 15 * 60_000)
    expect(cooled.until).toBeLessThanOrEqual(Date.now() + 15 * 60_000)

    // `rate_limit_exceeded` contains "exceeded", which the previous bare /exceeded/i
    // read as a terminal quota verdict — so this request used to lose its retries.
    expect(classifyMinimaxFailure(429, '{"errorReason":"rate_limit_exceeded"}')).toMatchObject({
      code: 'RATE_LIMIT',
      retryable: true,
      accountScoped: false,
    })
  })

  it('gives a spent plan window its own length and ignores Retry-After for it', async () => {
    const { pool, firstId } = await twoAccountPool()
    const adapter = new MinimaxCodeAdapter({} as never, {
      // A 3-second Retry-After on a plan refusal is back-pressure arithmetic about a
      // window that does not care how long you wait, so the interval window's own
      // length wins (kimi-code:840-845).
      fetchFn: refusingFetch(429, { message: 'insufficient balance, please recharge' }, { 'retry-after': '3' }),
      accountPool: pool,
    })

    const before = Date.now()
    await failureOf(adapter)
    const cooled = await cooldownOf(pool, firstId)
    // markCooldown stamps the instant the failure was classified, so the window is
    // read against a clock captured either side of the call rather than after it.
    expect(cooled.until).toBeGreaterThanOrEqual(before + 5 * 60 * 60_000)
    expect(cooled.until).toBeLessThanOrEqual(Date.now() + 5 * 60 * 60_000)
  })

  it('reads a quota verdict out of the base_resp/status_msg envelope', async () => {
    // The envelope this line documents for the platform routes, on the Messages
    // route: the reason is in base_resp.status_msg and in no other field.
    const failure = classifyMinimaxFailure(
      429,
      JSON.stringify({ base_resp: { status_code: 2013, status_msg: '您的额度已用尽，请充值后重试' } }),
    )
    expect(failure).toMatchObject({ code: 'PROVIDER_ERROR', retryable: false, accountScoped: true })
    // The sentence, not the envelope the user would otherwise be shown.
    expect(failure.message).toContain('您的额度已用尽')
    expect(failure.message).not.toContain('base_resp')
  })

  it('takes the weekly length when the refusal names the weekly window', async () => {
    const { pool, firstId } = await twoAccountPool()
    const adapter = new MinimaxCodeAdapter({} as never, {
      fetchFn: refusingFetch(429, { errorReason: 'weekly quota exhausted' }),
      accountPool: pool,
    })

    const before = Date.now()
    await failureOf(adapter)
    const cooled = await cooldownOf(pool, firstId)
    expect(cooled.until).toBeGreaterThanOrEqual(before + 6 * 24 * 60 * 60_000)
    expect(cooled.until).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60_000)
  })

  it('cools the account an in-band 429 names, before any output has started', async () => {
    const { pool, firstId } = await twoAccountPool()
    const adapter = new MinimaxCodeAdapter({} as never, {
      fetchFn: inBandErrorFetch({ type: 'rate_limit_error', message: 'insufficient balance, please recharge your account' }),
      accountPool: pool,
    })

    const thrown = await failureOf(adapter)
    expect(thrown).not.toBeNull()
    // Same reaction as the HTTP branch, on the body a non-2xx would have carried.
    // The request is NOT re-issued — its body is open — so cooling the account is
    // all that can be done here, and it is what makes the harness retry land
    // somewhere that can answer.
    const cooled = await cooldownOf(pool, firstId)
    expect(cooled.until).toBeGreaterThan(Date.now())
    expect(cooled.reason).toBe(PROVIDER_NAME + ' in-stream 429')
  })
})

describe('the same 429 on a line with no pool', () => {
  it('still only throws, and touches nothing', async () => {
    await writePluginCredential(credential(1))
    const store = new MinimaxCodeCredentialStore('cn')
    const adapter = new MinimaxCodeAdapter(store, {
      fetchFn: refusingFetch(429, { base_resp: { status_code: 2013, status_msg: '额度不足' } }),
    })

    const thrown = await failureOf(adapter)
    // No pool means no account to cool, and that combination must behave exactly as
    // it did before any of this existed: one classified throw, no new error type.
    expect((thrown as { code?: string }).code).toBe('PROVIDER_ERROR')
    expect(thrown?.message).toMatch(/quota is exhausted/)
  })

  it('reports a plain rate limit as retryable, unchanged', async () => {
    await writePluginCredential(credential(1))
    const store = new MinimaxCodeCredentialStore('cn')
    const adapter = new MinimaxCodeAdapter(store, {
      fetchFn: refusingFetch(429, { message: 'too many requests' }, { 'retry-after': '5' }),
    })

    const thrown = await failureOf(adapter)
    expect((thrown as { code?: string }).code).toBe('RATE_LIMIT')
    expect(thrown?.message).toMatch(/rate limited or overloaded/)
  })
})

// ---------------------------------------------------------------------------
// Rotation: the 429 has to end the ACCOUNT part of the turn, not the turn.
// ---------------------------------------------------------------------------

/**
 * A pool that refused one account and had another one answer the SAME request.
 *
 * The seven sibling lines all cool a refused account and then rotate onto another
 * one inside the caller's single request (command-code:513-518, kimi-code:834-863,
 * ollama:315-322, workbuddy:376-388, responses-client:276-292, claude:761-774).
 * This line cooled the account and then threw, so a pool of two accounts could
 * never use the second one to answer a turn the first one refused: the user was
 * shown one account's quota error while the pool sat there with an account left.
 *
 * These cases pin the rotation itself, and pin the three places it must NOT
 * happen: a request-level refusal, a pool with nothing left, and a line with no
 * pool at all.
 */
describe('a 429 the pool can answer from another account', () => {
  it('serves the one request from the second account, in the same stream', async () => {
    const { pool, firstId, secondId } = await twoAccountPool()
    // The evidence is the ORDER of the bearer tokens: the first request was served
    // by the exhausted account and the second by the other one, inside ONE
    // adapter.stream() call. One token would mean the retry never happened; a
    // throw would mean it happened but lost.
    const seen: string[] = []
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const bearer = bearerOf(init)
      seen.push(bearer)
      if (bearer === 'Bearer at-1') {
        return new Response(
          JSON.stringify({ base_resp: { status_code: 2013, status_msg: '当前套餐额度已耗尽' } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        )
      }
      return answerStream('answered by the second account')
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    const chunks: { type: string; text?: string }[] = []
    for await (const chunk of adapter.stream(request as never)) chunks.push(chunk)

    // (i) both accounts served this one request, in that order.
    expect(seen).toEqual(['Bearer at-1', 'Bearer at-2'])
    // (iii) the caller got an ANSWER, not the first account refusal.
    expect(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'answered by the second account')).toBe(true)
    // (ii) and the refused account was cooled while the one that answered was not:
    // cooling the second would put a working account out of rotation.
    const refused = await cooldownOf(pool, firstId)
    expect(refused.until).toBeGreaterThan(Date.now())
    expect(refused.reason).toBe(PROVIDER_NAME + ' 429')
    expect((await pool.read()).accounts.find((account) => account.id === secondId)?.cooldownUntil).toBeUndefined()
  })

  it('still throws the same verdict when the pool has no other account left', async () => {
    const { pool, firstId } = await oneAccountPool()
    const detail = JSON.stringify({ base_resp: { status_code: 2013, status_msg: '额度不足' } })
    const fetchFn = refusingFetch(429, { base_resp: { status_code: 2013, status_msg: '额度不足' } })

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    const thrown = await failureOf(adapter)

    // The LAST refusal is still what the user is shown, and it is the pre-existing
    // verdict: same code, same message, no new error type invented for this branch.
    expect((thrown as { code?: string }).code).toBe('PROVIDER_ERROR')
    expect(thrown?.message).toBe(classifyMinimaxFailure(429, detail).message)
    expect(thrown?.message).toMatch(/quota is exhausted/)
    // One request, not two: with nothing left to rotate to the loop stops at the
    // refusal instead of re-presenting a body the pool cannot place.
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
    expect((await cooldownOf(pool, firstId)).until).toBeGreaterThan(Date.now())
  })

  it('does not rotate a request-level refusal, which is about the request', async () => {
    const { pool, firstId } = await twoAccountPool()
    // A 400 is the same body for every account, so replaying it on the second one
    // would only empty the pool over one bad turn. Same for a 5xx.
    for (const status of [400, 503]) {
      const fetchFn = refusingFetch(status, { message: 'bad request shape' })
      const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
      const thrown = await failureOf(adapter)

      expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
      expect((await cooldownOf(pool, firstId)).until).toBeUndefined()
      expect(thrown).not.toBeNull()
    }
  })

  it('re-uploads under the NEW account, so the replayed body carries its file id', async () => {
    // The real coupling that makes the rotation non-trivial:
    // uploadOversizedMedia hands the CURRENT account access token and account key
    // to the Files API, and a file id is only readable by the account that minted
    // it. A round replayed against a second account therefore has to re-run the
    // upload under it, or that account is asked to read the first one file.
    //
    // A clip, because that is the media the Files API is actually reachable for
    // here: an image measures against the same byte budget in the offload pass
    // (base64Length of its declared size) and in the upload pass, so it can never
    // pass one and fail the other. A video is measured against the 16 MB body
    // limit on the way out and against this line's image budget on the way in, so
    // lowering that budget with the deployment override is enough to make the
    // upload path fire without allocating megabytes in a test.
    process.env.DSH_MINIMAX_CODE_MAX_IMAGE_BYTES = '16'
    const { pool } = await twoAccountPool()

    const uploads: string[] = []
    const messages: string[] = []
    const bodies: string[] = []
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const bearer = bearerOf(init)
      if (String(input).includes('/files/upload')) {
        uploads.push(bearer)
        return Response.json({ base_resp: { status_code: 0 }, file: { file_id: 'file-for-' + bearer } })
      }
      messages.push(bearer)
      if (bearer === 'Bearer at-1') {
        return new Response(
          JSON.stringify({ base_resp: { status_code: 2013, status_msg: '额度已耗尽' } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        )
      }
      bodies.push(String(init?.body ?? ''))
      return answerStream('answered with the second account upload')
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    const chunks: { type: string; text?: string }[] = []
    for await (const chunk of adapter.stream({
      provider: PROVIDER_ID,
      model: 'MiniMax-M3',
      messages: [{
        role: 'user',
        content: [{ type: 'video', mediaType: 'video/mp4', data: 'A'.repeat(2_048) }],
      }],
    } as never)) chunks.push(chunk)

    // The upload ran per round, every time under the account serving that round,
    // which is the whole reason it moved into the rotation. Two uploads per round
    // because uploadOversizedMedia walks the content once per media map and the
    // clip is collectable from both; the pair belongs to one round either way, and
    // it is the SECOND pair that carries the second account.
    expect(uploads).toEqual(['Bearer at-1', 'Bearer at-1', 'Bearer at-2', 'Bearer at-2'])
    expect(messages).toEqual(['Bearer at-1', 'Bearer at-2'])
    // And the replayed body therefore references the SECOND account file, not the
    // first one: a stale mm_file:// reference is unreadable by the account now
    // being asked to answer.
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('mm_file://file-for-Bearer at-2')
    expect(bodies[0]).not.toContain('file-for-Bearer at-1')
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
  })
})

/**
 * The 401 recovery, which is deliberately NOT the rotation.
 *
 * Two loops with two counters on purpose: this one asks whether the credential
 * just presented is stale, and its answer is fixed for THIS account; rotation
 * asks whether a different account is left, and its answer is about the pool. A
 * shared counter would make a 401 that survives its own renewal turn into a new
 * account on the next pass, which both hides a credential that needs a new
 * sign-in and spends the single retry a stale token is entitled to.
 */
describe('the 401 recovery, which is not the rotation', () => {
  it('renews once for the SAME account and never becomes a rotation', async () => {
    const { pool, firstId, secondId } = await twoAccountPool()
    const renewed: MinimaxCodeCredentials = { ...credential(1), accessToken: 'at-1-renewed', generation: 2 }
    const renewedFor: string[] = []
    vi.spyOn(pool, 'renewCredential').mockImplementation(async (accountId?: string) => {
      renewedFor.push(String(accountId))
      return renewed
    })

    const seen: string[] = []
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(bearerOf(init))
      return new Response(JSON.stringify({ message: 'token is required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    const thrown = await failureOf(adapter)

    // One renewal, for the account that was actually refused, and one replay with
    // that SAME account renewed token. The second account was available the whole
    // time and was deliberately not used.
    expect(renewedFor).toEqual([firstId])
    expect(seen).toEqual(['Bearer at-1', 'Bearer at-1-renewed'])
    expect(seen).not.toContain('Bearer at-2')
    expect((await pool.read()).accounts.find((account) => account.id === secondId)?.cooldownUntil).toBeUndefined()
    // The refusal that survives the recovery is reported, redacted, as before.
    expect(thrown).not.toBeNull()
    expect(thrown?.message).toMatch(/token is required/)
    expect(thrown?.message).toContain('sha256:')
    expect(thrown?.message).not.toContain('at-1-renewed')
  })
})

describe('the same 429 on a line with no pool at all', () => {
  it('makes one request, renews nothing, and throws the pre-existing verdict', async () => {
    await writePluginCredential(credential(1))
    const store = new MinimaxCodeCredentialStore('cn')
    const detail = JSON.stringify({ base_resp: { status_code: 2013, status_msg: '额度不足' } })
    const fetchFn = refusingFetch(429, { base_resp: { status_code: 2013, status_msg: '额度不足' } })

    const adapter = new MinimaxCodeAdapter(store, { fetchFn })
    const thrown = await failureOf(adapter)

    // One request: there is no pool, so there is nothing to rotate to and the
    // request phase must not run a second time looking for one.
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
    expect((thrown as { code?: string }).code).toBe('PROVIDER_ERROR')
    expect(thrown?.message).toBe(classifyMinimaxFailure(429, detail).message)
    // No refresh was attempted either: a 429 is not a 401, and the stored
    // credential is left exactly as the line found it.
    const stored = JSON.parse(await fs.readFile(pluginCredentialPath(), 'utf8')) as MinimaxCodeCredentials
    expect(stored.generation).toBe(1)
    expect(stored.accessToken).toBe('at-1')
  })
})
// ---------------------------------------------------------------------------
// The same spent window, reported as a 403 instead of a 429.
// ---------------------------------------------------------------------------

/**
 * The quota verdict under a status the line never handled.
 *
 * MiniMax does not only answer a spent Token Plan with 429: the same window arrives
 * as a 403 on some routes, and until this branch existed that 403 was classified as
 * a refused credential — so the account was neither cooled nor rotated, and one
 * exhausted account kept serving every later request while the pool sat there with
 * accounts that could answer. The sibling line already draws this distinction
 * (kimi-code/adapter.ts:848-862).
 *
 * The hard half is not the 403 but the 403 NEXT TO it. A credential-class 403 on
 * the same pool must not be cooled or rotated either, or one unusable token walks
 * the whole pool; those cases are pinned below with this same file's helpers.
 */
describe('a spent window reported as a 403', () => {
  it('reads a spent window and a refused credential apart on the body, not the status', () => {
    const body = JSON.stringify({ base_resp: { status_code: 2013, status_msg: '您的额度已用尽，请充值后重试' } })

    // The window is spent either way and the remedy is the same either way, so it
    // is ONE classification reached from two statuses — a caller branching on the
    // status would only end up with two copies of this sentence to keep in step.
    expect(classifyMinimaxFailure(403, body)).toEqual(classifyMinimaxFailure(429, body))
    expect(classifyMinimaxFailure(403, body)).toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: false,
      accountScoped: true,
    })
    // The service's own sentence, not the envelope the user would otherwise read.
    expect(classifyMinimaxFailure(403, body).message).toContain('您的额度已用尽')

    // A 403 the quota table does not match is still a refused credential: same
    // wording it used to get, same code, same accountScoped flag.
    expect(classifyMinimaxFailure(403, JSON.stringify({ message: 'invalid access token' }))).toMatchObject({
      code: 'INVALID_CREDENTIAL',
      retryable: false,
      accountScoped: true,
    })

    // And a 401 is the credential however its body reads. On this route the service
    // answers it both when no credential was sent and when the one sent is refused,
    // so reading quota wording into it would cool an account whose token is fine.
    expect(classifyMinimaxFailure(401, JSON.stringify({ message: 'insufficient balance' }))).toMatchObject({
      code: 'INVALID_CREDENTIAL',
      accountScoped: true,
    })
  })

  it('cools the exhausted account without renewing it, and serves the same turn from the second one', async () => {
    const { pool, firstId, secondId } = await twoAccountPool()
    const seen: string[] = []
    let tokenCalls = 0
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isTokenEndpoint(input)) { tokenCalls += 1; return tokenExchange('at-1-rotated', 'rt-1-rotated') }
      const bearer = bearerOf(init)
      seen.push(bearer)
      if (bearer === 'Bearer at-2') return answerStream('answered by the second account')
      return new Response(
        JSON.stringify({ base_resp: { status_code: 2013, status_msg: '当前套餐额度已耗尽' } }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    const chunks: { type: string; text?: string }[] = []
    for await (const chunk of adapter.stream(request as never)) chunks.push(chunk)

    // TWO requests, and neither of them is a renewal.
    //
    // This case used to expect three, the middle one being this line's own 401
    // recovery: a 403 went through renew-and-replay exactly as a 401 does, because
    // the status alone could not say which of the two it was and only the body can.
    // The pool side CAN say it now (classifyMinimaxFailure reads this very body as a
    // — spent window, which is the verdict it cools and rotates on), so the renewal
    // — skipped and the 403 falls straight through to that branch. It bought nothing:
    // — a window is spent whether the token is fresh or rotated.
    expect(seen).toEqual(['Bearer at-1', 'Bearer at-2'])
    // ...and skipped means skipped. The token endpoint was never touched at all, where
    // before this account was renamed once per quota verdict: a full round trip on
    // every account of the rotation, on every turn that met a spent window.
    expect(tokenCalls).toBe(0)
    // The caller got the second account's answer, not the first account's refusal.
    expect(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'answered by the second account')).toBe(true)
    // ...and only the account that was actually refused left rotation.
    const refused = await cooldownOf(pool, firstId)
    expect(refused.until).toBeGreaterThan(Date.now())
    expect(refused.reason).toBe(PROVIDER_NAME + ' 403')
    expect((await pool.read()).accounts.find((account) => account.id === secondId)?.cooldownUntil).toBeUndefined()
    // The refused account is out of rotation and the one that answered is in it — the
    // window resets on its own, so the account is kept, not dropped.
    expect((await pool.getEffectiveCredential(undefined, fetch)).account.id).toBe(secondId)
  })

  it('sizes the cooldown from the window the body names, like a 429 does', async () => {
    const { pool, firstId } = await oneAccountPool()
    const detail = JSON.stringify({ base_resp: { status_code: 2013, status_msg: '每周额度已耗尽' } })
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      if (isTokenEndpoint(input)) return tokenExchange('at-1-rotated', 'rt-1-rotated')
      return new Response(detail, { status: 403, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const before = Date.now()
    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    const thrown = await failureOf(adapter)

    // The last refusal is still what the user is shown, and it is the quota verdict
    // rather than the credential one — the same sentence the 429 branch already used.
    expect((thrown as { code?: string }).code).toBe('PROVIDER_ERROR')
    expect(thrown?.message).toBe(classifyMinimaxFailure(403, detail).message)
    expect(thrown?.message).toMatch(/quota is exhausted/)
    // The weekly window takes the weekly length, on a 403 exactly as on a 429.
    const cooled = await cooldownOf(pool, firstId)
    expect(cooled.until).toBeGreaterThanOrEqual(before + 6 * 24 * 60 * 60_000)
    expect(cooled.until).toBeLessThanOrEqual(Date.now() + 7 * 24 * 60 * 60_000)
  })

  it('reads the refused body once, and the verdict the user is shown comes off the real body', async () => {
    // The body has to survive being read twice BY DESIGN: once to tell a spent window
    // from a refused credential before the renewal, and once to classify it into the
    // sentence the user is shown. A Response body is a one-shot stream, so a second
    // read of a drained body comes back as '' — and an empty 403 body is not a
    // shorter verdict, it is a DIFFERENT one: the credential branch, with no detail in
    // the message and a redacted token appended. This is the case that catches it, so
    // it asserts the sentence the service itself sent rather than a shape.
    const { pool, firstId } = await oneAccountPool()
    const detail = JSON.stringify({ base_resp: { status_code: 2013, status_msg: '您的额度已用尽，请充值后重试' } })
    let tokenCalls = 0
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      if (isTokenEndpoint(input)) { tokenCalls += 1; return tokenExchange('at-1-rotated', 'rt-1-rotated') }
      return new Response(detail, { status: 403, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    const thrown = await failureOf(adapter)

    // The service's own sentence, carried by the base_resp envelope it arrived in.
    expect((thrown as { code?: string }).code).toBe('PROVIDER_ERROR')
    expect(thrown?.message).toBe(classifyMinimaxFailure(403, detail).message)
    expect(thrown?.message).toContain('您的额度已用尽')
    // Neither of the two ways this goes wrong when the body is read twice.
    expect(thrown?.message).not.toContain('sha256:')
    expect(thrown?.message).not.toMatch(/rejected the stored credential/)
    // One request, no renewal, and the account this verdict cooled.
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
    expect(tokenCalls).toBe(0)
    const cooled = await cooldownOf(pool, firstId)
    expect(cooled.until).toBeGreaterThan(Date.now())
    expect(cooled.reason).toBe(PROVIDER_NAME + ' 403')
  })

  it('does not blame the token for a window that is spent', async () => {
    const { pool } = await twoAccountPool()
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      if (isTokenEndpoint(input)) return tokenExchange('at-1-rotated', 'rt-1-rotated')
      return new Response(
        JSON.stringify({ base_resp: { status_code: 2013, status_msg: '额度不足' } }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    const thrown = await failureOf(adapter)

    // The redacted-credential hint names the token the service refused. A spent
    // window refused no token, so the message must not send the user off to sign in
    // again over a session that is working perfectly well.
    expect(thrown?.message).toContain('额度不足')
    expect(thrown?.message).not.toContain('sha256:')
  })
})
// ---------------------------------------------------------------------------
// A refusal about the CREDENTIAL: never cooled, never rotated.
// ---------------------------------------------------------------------------

/**
 * The two statuses the spent-window branch sits next to, and must not swallow.
 *
 * accountScoped is true for a refused credential as well as for a spent window, so
 * it cannot gate the cooldown on its own — and if it did, one unusable token would
 * walk the pool account by account, each one presented to a service that is
 * refusing it for a reason a different account does not fix. The 401 recovery is
 * deliberately not a rotation (see the case above), and these cases pin that the
 * 403 did not become one either.
 */
describe('a refusal about the credential, which must not cool or rotate', () => {
  it('stays on one account for the 401 and for the 403, and cools neither', async () => {
    const cases = [
      [401, { message: 'token is required' }],
      [403, { message: 'invalid access token' }],
      // Precedence is deliberate and pinned above: a 403 whose body DOES name a spent
      // window is a window, whatever else the sentence says. These are the 403s the
      // quota table cannot place, and every one of them is the credential.
      [403, { message: 'access denied' }],
      [403, { error: 'forbidden', errorReason: 'invalid_api_key' }],
    ] as const

    for (const [status, body] of cases) {
      const { pool, firstId, secondId } = await twoAccountPool()
      vi.spyOn(pool, 'renewCredential').mockImplementation(async () => ({ ...credential(1), accessToken: 'at-1-renewed', generation: 2 }))

      const seen: string[] = []
      const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(bearerOf(init))
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch

      const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
      const thrown = await failureOf(adapter)

      expect((thrown as { code?: string }).code).toBe('INVALID_CREDENTIAL')
      // One recovery, for the SAME account, then the verdict. The second account was
      // available the whole time and was deliberately not used.
      expect(seen).toEqual(['Bearer at-1', 'Bearer at-1-renewed'])
      expect(seen).not.toContain('Bearer at-2')
      expect(seen).toHaveLength(2)
      expect((await cooldownOf(pool, firstId)).until).toBeUndefined()
      expect((await cooldownOf(pool, secondId)).until).toBeUndefined()
      vi.restoreAllMocks()
    }
  })

  it('reports the same verdict on a pool of one, where rotation has nowhere to go', async () => {
    const { pool, firstId } = await oneAccountPool()
    vi.spyOn(pool, 'renewCredential').mockImplementation(async () => ({ ...credential(1), accessToken: 'at-1-renewed', generation: 2 }))

    const seen: string[] = []
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(bearerOf(init))
      return new Response(JSON.stringify({ message: 'invalid access token' }), { status: 403, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    const thrown = await failureOf(adapter)

    expect((thrown as { code?: string }).code).toBe('INVALID_CREDENTIAL')
    expect(thrown?.message).toMatch(/rejected the stored credential/)
    expect(seen).toEqual(['Bearer at-1', 'Bearer at-1-renewed'])
    // A credential verdict cools nothing: what it says is "this token is refused",
    // and a cooldown would only hide that behind a timer.
    expect((await cooldownOf(pool, firstId)).until).toBeUndefined()
  })
})
// ---------------------------------------------------------------------------
// What the pool is told about a credential it cannot use.
// ---------------------------------------------------------------------------

/**
 * Why this file pins what the pool does NOT get told.
 *
 * The adapter classifies a CREDENTIAL 401/403 only after its one renewal has already
 * been tried: the recovery loop breaks out of the retry only once a fresh token has
 * been refused, and a renewal that fails outright throws before classification ever
 * runs. So every credential-class refusal that reaches the pool branch has already
 * survived a rotation, and a refusal at that point is a verdict about a token that
 * was seconds old — which is exactly the shape
 * the pool was built to distrust: a rotation that SUCCEEDED can still produce a
 * final-looking verdict, and that is why healStaleAuthFailures exists
 * (account-pool.ts:597-641).
 *
 * A 403 that names a spent window is the one exception, and it reaches the pool branch
 * UNRENEWED: the recovery loop reads its body first and hands it straight down, because
 * a window is not a stale token and no refresh can affect one (adapter.ts:1019). That is
 * safe here precisely because a spent window never becomes an auth verdict: it cools
 * and rotates, and a cooldown says nothing about whether the sign-in is alive.
 *
 * The evidence that really does mean "this sign-in is gone" already has its own
 * path, and it is the token endpoint's, not the model request's: refreshFailureStatus
 * (account-pool.ts:480) turns a final refresh failure into authStatus, and the core
 * writes it only while the row still holds the credential the refresh started from
 * (common/account-pool.ts:807-820). isRefreshTokenRejected takes the same account out
 * of routing without a marker at all (account-pool.ts:483, common:587).
 *
 * So the adapter does not call markAuthFailed here, and these cases are what make
 * that decision checkable rather than asserted.
 */
describe('what the pool learns about an unusable credential', () => {
  it('marks the account expired when its own renewal is finally refused', async () => {
    const { pool, firstId, secondId } = await twoAccountPool()
    const modelRequests: string[] = []
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isTokenEndpoint(input)) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      modelRequests.push(bearerOf(init))
      return new Response(JSON.stringify({ message: 'token is required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    const thrown = await failureOf(adapter)

    // One request: the renewal produced no token, so there was nothing to replay.
    expect(modelRequests).toEqual(['Bearer at-1'])
    expect((thrown as { code?: string }).code).toBe('INVALID_CREDENTIAL')
    // ...and the row DOES learn. The adapter writes nothing here; the pool's own
    // refreshFailureStatus hook does, from the token endpoint's final verdict.
    const marked = (await pool.read()).accounts.find((account) => account.id === firstId)
    expect(marked?.authStatus).toBe('expired')
    expect(marked?.authFailedReason).toMatch(/rejected the stored refresh token/)
    // ...and the marker is what takes it out of rotation: the account stays in the
    // pool (signing in again restores it) while the next request goes elsewhere.
    expect((await pool.getEffectiveCredential(undefined, fetch)).account.id).toBe(secondId)
    expect((await pool.read()).accounts).toHaveLength(2)
  })

  it('leaves a request-stage refusal unmarked, because a fresh token is no evidence', async () => {
    const { pool, firstId, secondId } = await twoAccountPool()
    const seen: string[] = []
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isTokenEndpoint(input)) return tokenExchange('at-1-rotated', 'rt-1-rotated')
      seen.push(bearerOf(init))
      return new Response(JSON.stringify({ message: 'token is required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    expect((await failureOf(adapter))).not.toBeNull()

    // The renewal SUCCEEDED and the rotated token was refused anyway. Marking this
    // row expired would claim the sign-in is dead on the strength of a token that
    // was minted seconds ago, which is the one thing this line has been built not to
    // do — and the marker would not even be self-clearing, because the store holds
    // exactly the pair the row now holds.
    expect(seen).toEqual(['Bearer at-1', 'Bearer at-1-rotated'])
    const row = (await pool.read()).accounts.find((account) => account.id === firstId)
    expect(row?.authStatus).toBeUndefined()
    expect(row?.authFailedReason).toBeUndefined()
    expect(row?.cooldownUntil).toBeUndefined()
    // Both accounts are still routable, so the next request is served normally
    // rather than being parked at "sign in again".
    expect((await pool.getEffectiveCredential(undefined, fetch)).account.id).toBe(firstId)
    expect((await pool.read()).accounts.find((account) => account.id === secondId)?.authStatus).toBeUndefined()
  })

  it('does not park the desktop-app account on a refusal', async () => {
    // The row this line is most careful about. A native account is a COPY of a
    // session the desktop app keeps using and rotating, and the app's file is the
    // only authority on it (account-pool.ts:542-547, 704-746). A marker written here
    // would take that account out of rotation with a card reading "sign in again"
    // while the app itself is signed in and working — and it would not heal, because
    // the successful rotation wrote the very pair the row now holds into the app's
    // auth.json (account-pool.ts:466-468), so healStaleAuthFailures finds no advance
    // to reconcile (account-pool.ts:624-640).
    await writeNativeCredential('cn', { accessToken: 'at-native', refreshToken: 'rt-native' })
    const store = new MinimaxCodeCredentialStore('cn')
    const pool = new MinimaxCodeAccountPool({ store, backend: new PoolBackend() as never })
    const adopted = await pool.adoptNativeAccount()

    const seen: string[] = []
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isTokenEndpoint(input)) return tokenExchange('at-native-rotated', 'rt-native-rotated')
      seen.push(bearerOf(init))
      return new Response(JSON.stringify({ message: 'token is required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter({} as never, { fetchFn, accountPool: pool })
    expect((await failureOf(adapter))).not.toBeNull()

    expect(seen).toEqual(['Bearer at-native', 'Bearer at-native-rotated'])
    const row = (await pool.read()).accounts[0]
    expect(row?.authStatus).toBeUndefined()
    expect(row?.cooldownUntil).toBeUndefined()
    // Adopted means never disturbed: the row is still routable and still carries the
    // credential the app itself is now holding.
    expect((await pool.getEffectiveCredential(undefined, fetch)).account.id).toBe(adopted.id)
  })
})
// ---------------------------------------------------------------------------
// The same 403 on the single-credential line, which has no pool at all.
// ---------------------------------------------------------------------------

/**
 * What may not move without a pool.
 *
 * The pool is optional in a composition, so the line without one keeps the posture
 * it had before pools existed: one request, one forced renewal on a 401 or a 403, one
 * replay, then the classified throw. Nothing here calls the pool and nothing new is
 * written anywhere — the single place the 403 changes the outcome is the message:
 * a body that names a spent window now says so, instead of telling a user whose
 * session is fine to sign in again.
 *
 * That includes the spent-window 403, which is NOT diverted out of the recovery on
 * this line even though its body says the window is spent. There is no second account
 * here for the verdict to be handed to, so skipping the renewal would buy nothing and
 * cost the stored credential its rotation; the last case below pins it byte for byte.
 */
describe('the same 403 on a line with no pool', () => {
  it('renews once, replays once, and throws the credential verdict as before', async () => {
    await writePluginCredential(credential(1))
    const store = new MinimaxCodeCredentialStore('cn')
    const seen: string[] = []
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isTokenEndpoint(input)) return tokenExchange('at-1-rotated', 'rt-1-rotated')
      seen.push(bearerOf(init))
      return new Response(JSON.stringify({ message: 'invalid access token' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter(store, { fetchFn })
    const thrown = await failureOf(adapter)

    // The single recovery is untouched: one request, one renewal, one replay.
    expect(seen).toEqual(['Bearer at-1', 'Bearer at-1-rotated'])
    expect((thrown as { code?: string }).code).toBe('INVALID_CREDENTIAL')
    expect(thrown?.message).toMatch(/rejected the stored credential/)
    expect(thrown?.message).toContain('sha256:')
    // The renewal reached the store exactly as it did before, so the file still
    // carries the rotated pair — the line's state is where it left it.
    const stored = JSON.parse(await fs.readFile(pluginCredentialPath(), 'utf8')) as MinimaxCodeCredentials
    expect(stored.generation).toBe(2)
    expect(stored.refreshToken).toBe('rt-1-rotated')
  })

  it('reports a spent window as a spent window rather than as a dead sign-in', async () => {
    await writePluginCredential(credential(1))
    const store = new MinimaxCodeCredentialStore('cn')
    const detail = JSON.stringify({ base_resp: { status_code: 2013, status_msg: '额度不足' } })
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      if (isTokenEndpoint(input)) return tokenExchange('at-1-rotated', 'rt-1-rotated')
      return new Response(detail, { status: 403, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter(store, { fetchFn })
    const thrown = await failureOf(adapter)

    // The one thing this branch does change on the no-pool line, and it changes the
    // verdict rather than the mechanics: no pool is consulted, the same single
    // recovery runs, and the user is told to top up instead of to sign in again.
    expect((thrown as { code?: string }).code).toBe('PROVIDER_ERROR')
    expect(thrown?.message).toBe(classifyMinimaxFailure(403, detail).message)
    expect(thrown?.message).toMatch(/quota is exhausted/)
    expect(thrown?.message).not.toContain('sha256:')
  })

  it('still renews a spent window once and replays it, because there is no other account', async () => {
    // The case that makes the pool-gated choice checkable rather than asserted.
    //
    // The recovery loop reads a 403's body before renewing it (a spent window is not a
    // stale token) but only DIVERTS out of the recovery when there is a pool to rotate
    // to. Without one the line keeps the posture it has always had: one forced renewal
    // on ANY 401 or 403, one replay, one classified throw. — which is what this pins.
    await writePluginCredential(credential(1))
    const store = new MinimaxCodeCredentialStore('cn')
    const seen: string[] = []
    let tokenCalls = 0
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isTokenEndpoint(input)) { tokenCalls += 1; return tokenExchange('at-1-rotated', 'rt-1-rotated') }
      seen.push(bearerOf(init))
      return new Response(
        JSON.stringify({ base_resp: { status_code: 2013, status_msg: '额度不足' } }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const adapter = new MinimaxCodeAdapter(store, { fetchFn })
    const thrown = await failureOf(adapter)

    // One request, one renewal, one replay, and the store left where the line put it.
    expect(seen).toEqual(['Bearer at-1', 'Bearer at-1-rotated'])
    expect(tokenCalls).toBe(1)
    // ...and the verdict is still the quota one, so skipping the renewal where a pool
    // exists changed no wording anywhere.
    expect((thrown as { code?: string }).code).toBe('PROVIDER_ERROR')
    expect(thrown?.message).toMatch(/quota is exhausted/)
    expect(thrown?.message).not.toContain('sha256:')
    const stored = JSON.parse(await fs.readFile(pluginCredentialPath(), 'utf8')) as MinimaxCodeCredentials
    expect(stored.generation).toBe(2)
    expect(stored.refreshToken).toBe('rt-1-rotated')
  })
})
