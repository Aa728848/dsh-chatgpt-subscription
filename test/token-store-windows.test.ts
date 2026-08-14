import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WindowsDpapiTokenStore } from '../src/host/token-store-windows.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'win32')('WindowsDpapiTokenStore', () => {
  it('round-trips with CurrentUser DPAPI and never writes plaintext', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-codex-dpapi-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'oauth.dpapi')
    const store = new WindowsDpapiTokenStore(path)
    const credentials = {
      accessToken: 'access-super-secret',
      refreshToken: 'refresh-super-secret',
      expiresAt: Date.now() + 60_000,
      accountId: 'account-id',
    }

    await store.save(credentials)
    expect(await store.load()).toEqual(credentials)
    const raw = await readFile(path)
    expect(raw.toString('utf8')).not.toContain('access-super-secret')
    expect(raw.toString('utf8')).not.toContain('refresh-super-secret')
    await store.clear()
    expect(await store.load()).toBeNull()
  })
})
