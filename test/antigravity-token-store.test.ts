import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileCredentialStore, type AntigravityCredentials } from '../src/host/antigravity/token-store.ts'
import type { CredentialStore } from '../src/host/token-store.ts'

const directories: string[] = []
const credentials: AntigravityCredentials = {
  access: 'antigravity-access-secret',
  access_token: 'antigravity-access-secret',
  refresh: 'antigravity-refresh-secret',
  refresh_token: 'antigravity-refresh-secret',
  expires: 2_000_000_000_000,
  expires_at: 2_000_000_000_000,
  projectId: 'test-project',
  email: 'test@example.com',
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function legacyPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-antigravity-store-'))
  directories.push(directory)
  return join(directory, 'antigravity-oauth.json')
}

function memoryBackend(initial: AntigravityCredentials | null = null): CredentialStore<AntigravityCredentials> {
  let value = initial
  return {
    load: vi.fn(async () => structuredClone(value)),
    save: vi.fn(async (next) => { value = structuredClone(next) }),
    clear: vi.fn(async () => { value = null }),
  }
}

describe('Antigravity encrypted credential migration', () => {
  it('migrates both token aliases and account metadata, then removes the legacy JSON', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credentials))
    const backend = memoryBackend()
    const store = new FileCredentialStore(path, backend)
    expect(await store.read()).toEqual(credentials)
    expect(backend.save).toHaveBeenCalledExactlyOnceWith(credentials)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await new FileCredentialStore(path, backend).read()).toEqual(credentials)
    expect(backend.save).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy file when encryption or read-back verification fails', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credentials))
    const backend = memoryBackend()
    vi.mocked(backend.save).mockRejectedValueOnce(new Error('keyring locked'))
    await expect(new FileCredentialStore(path, backend).read()).rejects.toThrow('keyring locked')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(credentials)

    vi.mocked(backend.load).mockResolvedValue(null)
    await expect(new FileCredentialStore(path, backend).read()).rejects.toThrow('verification failed')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(credentials)
  })

  it('does not fall back to plaintext when secure storage cannot be read', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credentials))
    const backend = memoryBackend()
    vi.mocked(backend.load).mockRejectedValue(new Error('encrypted payload damaged'))
    await expect(new FileCredentialStore(path, backend).read()).rejects.toThrow('encrypted payload damaged')
    expect(backend.save).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(credentials)
  })

  it('prefers encrypted credentials over a leftover stale JSON', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify({ access: 'stale-token' }))
    const backend = memoryBackend(credentials)
    expect(await new FileCredentialStore(path, backend).read()).toEqual(credentials)
    expect(backend.save).not.toHaveBeenCalled()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent migration and refreshed credential writes across instances', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credentials))
    const backend = memoryBackend()
    const first = new FileCredentialStore(path, backend)
    const second = new FileCredentialStore(path, backend)
    const next = { ...credentials, access: 'refreshed-access', access_token: 'refreshed-access' }
    await Promise.all([first.read(), second.write(next), first.read()])
    expect(await first.read()).toEqual(next)
    expect(backend.save).toHaveBeenCalledTimes(2)
  })

  it('writes new credentials only to the secure backend and clears both stores on logout', async () => {
    const path = await legacyPath()
    const backend = memoryBackend()
    const store = new FileCredentialStore(path, backend)
    await store.write(credentials)
    expect(await store.read()).toEqual(credentials)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(path, JSON.stringify({ access: 'stale-token' }))
    await store.delete()
    expect(await store.read()).toBeNull()
    expect(backend.clear).toHaveBeenCalledOnce()
  })

  it('rejects corrupt legacy credentials without exposing their contents', async () => {
    const path = await legacyPath()
    await writeFile(path, '{"access":"private-token", broken')
    const backend = memoryBackend()
    await expect(new FileCredentialStore(path, backend).read()).rejects.toThrow('legacy credential payload is invalid')
    expect(backend.save).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toContain('private-token')
  })
})

describe.skipIf(process.platform !== 'win32')('Antigravity Windows DPAPI', () => {
  it('migrates and refreshes real DPAPI ciphertext without leaving token plaintext on disk', async () => {
    const path = await legacyPath()
    await writeFile(path, JSON.stringify(credentials))
    const store = new FileCredentialStore(path)
    expect(await store.read()).toEqual(credentials)
    expect(await new FileCredentialStore(path).read()).toEqual(credentials)
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const raw = await readFile(store.path())
    for (const token of [credentials.access!, credentials.refresh!]) expect(raw.toString('utf8')).not.toContain(token)
    expect(await readdir(directories[directories.length - 1])).toEqual(['antigravity-oauth.json.dpapi'])
    const next = { refresh_token: 'rotated-refresh-secret', access_token: 'new-access-secret', expires_at: credentials.expires }
    await store.write(next)
    expect(await new FileCredentialStore(path).read()).toEqual(next)
    await store.delete()
    expect(await store.read()).toBeNull()
  }, 30_000)
})
