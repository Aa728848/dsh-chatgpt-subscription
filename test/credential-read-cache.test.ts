/**
 * Regression tests for the credential read snapshot.
 *
 * Every platform this plugin supports reads a credential by launching a
 * process: `powershell.exe` for DPAPI, `security` for the macOS Keychain,
 * `secret-tool` for the Linux Secret Service. Measured on a real machine, one
 * DPAPI read costs 200-243 ms, and a single settings request read the same
 * stored value several times — a status card asks the pool twice — so opening a
 * tab took 1-3 s.
 *
 * These tests pin the reuse rules rather than the wall clock: a read is skipped
 * only while the stored value is provably unchanged, a write is always
 * observed, and concurrent reads of the same identity share one read.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ABSENT_CREDENTIAL,
  CredentialReadCache,
  fileCredentialIdentity,
  keyringCredentialIdentity,
} from '../src/host/common/credential-read-cache.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryFile(name = 'credential.dpapi'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-credential-cache-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

describe('CredentialReadCache', () => {
  it('serves a second read of an unchanged value without reading again', async () => {
    const read = vi.fn(async () => ({ accessToken: 'token-1' }))
    const cache = new CredentialReadCache<{ accessToken: string }>(async () => 'identity-1')

    expect(await cache.load(read)).toEqual({ accessToken: 'token-1' })
    expect(await cache.load(read)).toEqual({ accessToken: 'token-1' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reads again when the stored value changed underneath', async () => {
    let identity = 'identity-1'
    const read = vi.fn(async () => ({ accessToken: identity }))
    const cache = new CredentialReadCache<{ accessToken: string }>(async () => identity)

    expect(await cache.load(read)).toEqual({ accessToken: 'identity-1' })
    identity = 'identity-2'
    expect(await cache.load(read)).toEqual({ accessToken: 'identity-2' })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('answers "nothing stored" without reading at all', async () => {
    const read = vi.fn(async () => null)
    const cache = new CredentialReadCache<string>(async () => ABSENT_CREDENTIAL)

    expect(await cache.load(read)).toBeNull()
    expect(await cache.load(read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('re-reads after a write invalidates the snapshot', async () => {
    const read = vi.fn(async () => ({ accessToken: 'token' }))
    const cache = new CredentialReadCache<{ accessToken: string }>(async () => 'identity-1')

    await cache.load(read)
    cache.invalidate()
    await cache.load(read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('never caches when the identity cannot be established', async () => {
    const read = vi.fn(async () => ({ accessToken: 'token' }))
    const cache = new CredentialReadCache<{ accessToken: string }>(async () => null)

    await cache.load(read)
    await cache.load(read)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('shares one read between concurrent readers of the same identity', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const read = vi.fn(async () => {
      await gate
      return { accessToken: 'token' }
    })
    const cache = new CredentialReadCache<{ accessToken: string }>(async () => 'identity-1')

    const first = cache.load(read)
    const second = cache.load(read)
    release?.()
    expect(await first).toEqual({ accessToken: 'token' })
    expect(await second).toEqual({ accessToken: 'token' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed read', async () => {
    const read = vi.fn(async () => { throw new Error('keyring locked') })
    const cache = new CredentialReadCache<{ accessToken: string }>(async () => 'identity-1')

    await expect(cache.load(read)).rejects.toThrow('keyring locked')
    await expect(cache.load(read)).rejects.toThrow('keyring locked')
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('credential identities', () => {
  it('keys a file on its mtime and size, and reports an absent file', async () => {
    const path = await temporaryFile()
    expect(await fileCredentialIdentity(path)).toBe(ABSENT_CREDENTIAL)

    await writeFile(path, 'first-payload')
    const first = await fileCredentialIdentity(path)
    expect(first).toMatch(/^\d+(\.\d+)?:\d+$/)

    // A different size is a different identity even within one mtime tick.
    await writeFile(path, 'a-longer-second-payload')
    expect(await fileCredentialIdentity(path)).not.toBe(first)

    await rm(path)
    expect(await fileCredentialIdentity(path)).toBe(ABSENT_CREDENTIAL)
  })

  it('keys a keyring on a stable time bucket', async () => {
    const first = await keyringCredentialIdentity(15_000)
    const second = await keyringCredentialIdentity(15_000)
    expect(first).toBe(second)
    expect(first).toMatch(/^bucket:\d+$/)
  })
})