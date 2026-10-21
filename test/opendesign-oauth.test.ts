/**
 * OpenDesign device-authorization sign-in: create, poll, completion into the
 * pool, and the failure vocabulary.
 *
 * The wire contract is probed live (2026-10-21) — the create call's 201 body
 * and the pending poll's 200 body are quoted in docs/opendesign-line-plan.md —
 * and the approval frame's shape is inferred from upstream issue
 * nexu-io/open-design#8870 (never observed: nobody approved a probe). The
 * reader keys on key presence rather than a status string, which is what makes
 * that inference safe to ship.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  OpenDesignLoginManager,
  pollOpenDesignDevice,
  startOpenDesignDeviceAuth,
} from '../src/host/opendesign/oauth.ts'
import { OpenDesignAccountPool } from '../src/host/opendesign/account-pool.ts'
import {
  FileCredentialStore,
  bearerFor,
  controlKeyFor,
  isOpenDesignOAuthCredentials,
  type OpenDesignCredentials,
} from '../src/host/opendesign/token-store.ts'

class MemoryBackend<T> {
  private data: unknown = null
  async load(): Promise<T | null> {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data)) as T
  }
  async save(data: T): Promise<void> {
    this.data = JSON.parse(JSON.stringify(data))
  }
  async clear(): Promise<void> {
    this.data = null
  }
}

/** The create call's 201 body, as probed (secrets replaced). */
function createAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    deviceId: 'dev-1',
    userCode: 'AB12CD',
    status: 'pending',
    cliVersion: 'dsh-chatgpt-subscription',
    host: 'probe-host',
    profile: 'prod',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    deviceSecret: 'secret-1',
    activationUrl: 'https://open-design.ai/cloud/cli/activate?deviceId=dev-1&userCode=AB12CD',
    pollIntervalSeconds: 2,
    ...overrides,
  }
}

/** The approved poll body, per the shape the pending frame implies plus #8870. */
function approvedAnswer(): Record<string, unknown> {
  return {
    ...createAnswer(),
    status: 'approved',
    controlKey: 'vela_ctrl_abc',
    runtimeKey: 'sk-amr-xyz',
    user: { id: 'u-1', email: 'dev@example.com', name: 'Dev', plan: 'pro' },
  }
}

function fetchReturning(...answers: Array<{ status: number; body: unknown }>): typeof fetch {
  let index = 0
  return (async () => {
    const answer = answers[Math.min(index++, answers.length - 1)]!
    return Response.json(answer.body, { status: answer.status })
  }) as typeof fetch
}

describe('startOpenDesignDeviceAuth', () => {
  it('posts the client identity and reads the 201 shape', async () => {
    let seenBody: Record<string, unknown> = {}
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return Response.json(createAnswer(), { status: 201 })
    }) as unknown as typeof fetch
    const device = await startOpenDesignDeviceAuth(fetchFn, { host: 'my-laptop' })
    expect(seenBody).toEqual({ host: 'my-laptop', profile: 'prod', cliVersion: 'dsh-chatgpt-subscription' })
    expect(device.deviceId).toBe('dev-1')
    expect(device.userCode).toBe('AB12CD')
    expect(device.deviceSecret).toBe('secret-1')
    expect(device.pollIntervalSeconds).toBe(2)
    expect(device.expiresAt).toBeGreaterThan(Date.now())
  })

  it('refuses an incomplete 201 instead of fabricating a flow', async () => {
    // A 200-class answer carrying no credential material is not a flow (shape,
    // not status).
    const fetchFn = (async () => Response.json({ status: 'pending' }, { status: 201 })) as typeof fetch
    await expect(startOpenDesignDeviceAuth(fetchFn, { host: 'h' })).rejects.toThrow(/incomplete/)
  })

  it('surfaces the service refusal with its own words', async () => {
    const fetchFn = (async () => Response.json({ error: 'rate limited' }, { status: 429 })) as typeof fetch
    await expect(startOpenDesignDeviceAuth(fetchFn, { host: 'h' })).rejects.toThrow(/429.*rate limited/)
  })
})

describe('pollOpenDesignDevice', () => {
  it('reads pending as pending and never as a credential', async () => {
    const fetchFn = (async () => Response.json({
      ...createAnswer(),
      controlKey: null,
      runtimeKey: null,
      user: null,
    })) as typeof fetch
    const verdict = await pollOpenDesignDevice(fetchFn, { deviceId: 'dev-1', deviceSecret: 'secret-1' })
    expect(verdict.pending).toBe(true)
  })

  it('completes on key presence, whatever a status string would say', async () => {
    const fetchFn = fetchReturning({ status: 200, body: approvedAnswer() })
    const verdict = await pollOpenDesignDevice(fetchFn, { deviceId: 'dev-1', deviceSecret: 'secret-1' })
    expect(verdict.pending).toBe(false)
    if (verdict.pending) throw new Error('unreachable')
    expect(verdict.credentials.kind).toBe('oauth')
    expect(verdict.credentials.controlKey).toBe('vela_ctrl_abc')
    expect(verdict.credentials.runtimeKey).toBe('sk-amr-xyz')
    expect(verdict.credentials.user).toEqual({ id: 'u-1', email: 'dev@example.com', name: 'Dev', plan: 'pro' })
  })

  it('a non-pending status without keys is a refusal, not a wait', async () => {
    const fetchFn = fetchReturning({ status: 200, body: { ...createAnswer(), status: 'denied', controlKey: null, runtimeKey: null } })
    await expect(pollOpenDesignDevice(fetchFn, { deviceId: 'dev-1', deviceSecret: 'secret-1' })).rejects.toThrow(/denied/)
  })
})

describe('OpenDesignLoginManager', () => {
  let dir = ''
  let pool: OpenDesignAccountPool

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opendesign-oauth-'))
    const credential = new FileCredentialStore(path.join(dir, 'credentials.json'), new MemoryBackend<OpenDesignCredentials>() as never)
    pool = new OpenDesignAccountPool({ store: credential, backend: new MemoryBackend() as never })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('completes a full flow: the account lands in the pool with both keys', async () => {
    const fetchFn = fetchReturning(
      { status: 201, body: createAnswer() },
      { status: 200, body: { ...createAnswer(), controlKey: null, runtimeKey: null, user: null } },
      { status: 200, body: approvedAnswer() },
    )
    const login = new OpenDesignLoginManager({
      fetchFn,
      host: () => 'test-host',
      onLogin: async (credentials) => {
        await pool.addAccount(credentials, credentials.user?.name ?? credentials.user?.email)
      },
    })
    const flow = await login.begin()
    expect(flow.status).toBe('pending')
    expect(flow.userCode).toBe('AB12CD')
    expect(flow.verificationUri).toContain('deviceId=dev-1')

    vi.useFakeTimers()
    try {
      // First poll is throttled until the advertised interval elapses.
      const early = await login.status(flow.id)
      expect(early.status).toBe('pending')
      vi.setSystemTime(Date.now() + 2_000)
      const waiting = await login.status(flow.id)
      expect(waiting.status).toBe('pending')
      vi.setSystemTime(Date.now() + 2_000)
      const done = await login.status(flow.id)
      expect(done.status).toBe('complete')
      expect(done.accountAlias).toBe('Dev')
    } finally {
      vi.useRealTimers()
    }

    const accounts = await pool.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.alias).toBe('Dev')
    expect(accounts[0]!.authKind).toBe('oauth')
    expect(accounts[0]!.email).toBe('dev@example.com')
    expect(accounts[0]!.plan).toBe('pro')
    login.dispose()
  })

  it('a cancelled flow never persists a late-arriving approval', async () => {
    const fetchFn = fetchReturning(
      { status: 201, body: createAnswer() },
      { status: 200, body: approvedAnswer() },
    )
    const login = new OpenDesignLoginManager({
      fetchFn,
      host: () => 'test-host',
      onLogin: async (credentials) => {
        await pool.addAccount(credentials, credentials.user?.name)
      },
    })
    const flow = await login.begin()
    expect(login.cancel(flow.id)).toBe(true)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 3_000)
      const after = await login.status(flow.id)
      expect(after.status).toBe('cancelled')
    } finally {
      vi.useRealTimers()
    }
    expect(await pool.listAccounts()).toHaveLength(0)
    login.dispose()
  })

  it('an expired authorization fails instead of polling forever', async () => {
    const fetchFn = fetchReturning({
      status: 201,
      body: createAnswer({ expiresAt: new Date(Date.now() + 1_000).toISOString() }),
    })
    const login = new OpenDesignLoginManager({
      fetchFn,
      host: () => 'test-host',
      onLogin: async () => {},
    })
    const flow = await login.begin()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 2_000)
      const after = await login.status(flow.id)
      expect(after.status).toBe('failed')
      expect(after.error).toContain('expired')
    } finally {
      vi.useRealTimers()
    }
    login.dispose()
  })

  it('a transient poll failure keeps the flow pending with the error noted', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls += 1
      if (calls === 1) return Response.json(createAnswer(), { status: 201 })
      if (calls === 2) throw new Error('socket reset')
      return Response.json(approvedAnswer())
    }) as unknown as typeof fetch
    const login = new OpenDesignLoginManager({
      fetchFn,
      host: () => 'test-host',
      onLogin: async (credentials) => {
        await pool.addAccount(credentials, credentials.user?.name)
      },
    })
    const flow = await login.begin()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 2_000)
      const blip = await login.status(flow.id)
      expect(blip.status).toBe('pending')
      expect(blip.error).toContain('socket reset')
      vi.setSystemTime(Date.now() + 4_000)
      const done = await login.status(flow.id)
      expect(done.status).toBe('complete')
    } finally {
      vi.useRealTimers()
    }
    expect(await pool.listAccounts()).toHaveLength(1)
    login.dispose()
  })

  it('a second begin() retires the first flow', async () => {
    const fetchFn = fetchReturning({ status: 201, body: createAnswer() })
    const login = new OpenDesignLoginManager({ fetchFn, host: () => 'h', onLogin: async () => {} })
    const first = await login.begin()
    const second = await login.begin()
    expect(second.id).not.toBe(first.id)
    await expect(login.status(first.id)).rejects.toThrow(/no longer active/)
    login.dispose()
  })
})

describe('the OAuth credential pair', () => {
  it('splits the bearers: runtime key for chat, control key for the wallet', () => {
    const credentials: OpenDesignCredentials = {
      kind: 'oauth',
      controlKey: 'vela_ctrl_abc',
      runtimeKey: 'sk-amr-xyz',
      user: { email: 'dev@example.com' },
    }
    expect(bearerFor(credentials)).toBe('sk-amr-xyz')
    expect(controlKeyFor(credentials)).toBe('vela_ctrl_abc')
    expect(isOpenDesignOAuthCredentials(credentials)).toBe(true)
    const pasted: OpenDesignCredentials = { kind: 'api-key', apiKey: 'od_x' }
    expect(bearerFor(pasted)).toBe('od_x')
    expect(controlKeyFor(pasted)).toBeUndefined()
    expect(isOpenDesignOAuthCredentials(pasted)).toBe(false)
  })
})
