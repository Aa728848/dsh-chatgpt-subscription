/**
 * Regression tests for credential reads that must not launch a process twice.
 *
 * Each uncached read is a process launch — `powershell.exe` for DPAPI on
 * Windows, `secret-tool` for the Linux Secret Service. A settings request reads
 * the same stored value more than once (a status card asks the pool twice), so
 * the count of launches is the assertion surface here: one unchanged value must
 * cost one launch no matter how many times a request reads it.
 *
 * The spawned helper is mocked so the test asserts launch counts rather than
 * touching real keyrings or DPAPI.
 */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowsDpapiCredentialStore } from '../src/host/token-store-windows.ts'
import { SecretServiceCredentialStore } from '../src/host/credential-store-secret-service.ts'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

/** Queue one helper invocation that settles with the given result. */
function helperResult(code: number, stdout = '', stderr = '', error?: Error): void {
  spawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    })
    queueMicrotask(() => {
      if (error) {
        child.emit('error', error)
        return
      }
      child.stdout.end(stdout)
      child.stderr.end(stderr)
      child.emit('close', code)
    })
    return child
  })
}

function launches(): number {
  return spawn.mock.calls.length
}

async function temporaryCredentialFile(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-credential-launches-'))
  temporaryDirectories.push(directory)
  const path = join(directory, name)
  await writeFile(path, 'stored-bytes')
  return path
}

describe.skipIf(process.platform !== 'win32')('WindowsDpapiCredentialStore launches', () => {
  it('decrypts once for repeated reads of an unchanged file', async () => {
    const path = await temporaryCredentialFile('oauth.dpapi')
    const store = new WindowsDpapiCredentialStore<{ accessToken: string }>(path, (value) => value as { accessToken: string })

    helperResult(0, JSON.stringify({ accessToken: 'token-1' }))
    expect(await store.load()).toEqual({ accessToken: 'token-1' })
    expect(launches()).toBe(1)

    // The settings request shape: the same value read again, and again.
    expect(await store.load()).toEqual({ accessToken: 'token-1' })
    expect(await store.load()).toEqual({ accessToken: 'token-1' })
    expect(launches()).toBe(1)
  })

  it('decrypts again after another process changes the file', async () => {
    const path = await temporaryCredentialFile('oauth.dpapi')
    const store = new WindowsDpapiCredentialStore<{ accessToken: string }>(path, (value) => value as { accessToken: string })

    helperResult(0, JSON.stringify({ accessToken: 'token-1' }))
    await store.load()
    expect(launches()).toBe(1)

    // A different length moves the identity even within one mtime tick.
    await writeFile(path, 'rotated-bytes-in-this-file')
    helperResult(0, JSON.stringify({ accessToken: 'token-2' }))
    expect(await store.load()).toEqual({ accessToken: 'token-2' })
    expect(launches()).toBe(2)
  })

  it('answers a missing file without launching anything', async () => {
    const path = await temporaryCredentialFile('oauth.dpapi')
    const store = new WindowsDpapiCredentialStore<{ accessToken: string }>(path, (value) => value as { accessToken: string })

    await rm(path)
    expect(await store.load()).toBeNull()
    expect(await store.load()).toBeNull()
    expect(launches()).toBe(0)
  })

  it('reads real storage after a write instead of trusting the snapshot', async () => {
    const path = await temporaryCredentialFile('oauth.dpapi')
    const store = new WindowsDpapiCredentialStore<{ accessToken: string }>(path, (value) => value as { accessToken: string })

    helperResult(0, JSON.stringify({ accessToken: 'token-1' }))
    await store.load()
    expect(launches()).toBe(1)

    // save() must not satisfy the verification read the pools perform.
    helperResult(0)
    await store.save({ accessToken: 'token-2' })
    expect(launches()).toBe(2)
    helperResult(0, JSON.stringify({ accessToken: 'token-2' }))
    expect(await store.load()).toEqual({ accessToken: 'token-2' })
    expect(launches()).toBe(3)
  })

  it('does not cache a failed helper invocation', async () => {
    const path = await temporaryCredentialFile('oauth.dpapi')
    const store = new WindowsDpapiCredentialStore<{ accessToken: string }>(path, (value) => value as { accessToken: string })

    helperResult(1)
    await expect(store.load()).rejects.toThrow('DPAPI credential read failed')
    helperResult(1)
    await expect(store.load()).rejects.toThrow('DPAPI credential read failed')
    expect(launches()).toBe(2)
  })
})

describe('SecretServiceCredentialStore launches', () => {
  function store(): SecretServiceCredentialStore<{ access: string }> {
    return new SecretServiceCredentialStore('dsh-antigravity', 'test-account', (value) => value as { access: string })
  }

  it('looks the secret up once for repeated reads', async () => {
    const instance = store()
    helperResult(0, JSON.stringify({ access: 'secret-access' }))
    expect(await instance.load()).toEqual({ access: 'secret-access' })
    expect(launches()).toBe(1)

    expect(await instance.load()).toEqual({ access: 'secret-access' })
    expect(launches()).toBe(1)
  })

  it('looks the secret up again after a write', async () => {
    const instance = store()
    helperResult(0, JSON.stringify({ access: 'secret-access' }))
    await instance.load()
    expect(launches()).toBe(1)

    helperResult(0)
    await instance.save({ access: 'rotated-access' })
    expect(launches()).toBe(2)

    helperResult(0, JSON.stringify({ access: 'rotated-access' }))
    expect(await instance.load()).toEqual({ access: 'rotated-access' })
    expect(launches()).toBe(3)
  })

  it('answers a missing entry without launching again on the next read', async () => {
    const instance = store()
    helperResult(1)
    expect(await instance.load()).toBeNull()
    expect(launches()).toBe(1)

    expect(await instance.load()).toBeNull()
    expect(launches()).toBe(1)
  })
})