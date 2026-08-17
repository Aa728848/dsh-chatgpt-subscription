import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LinuxFileTokenStore } from '../src/host/token-store-linux.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('LinuxFileTokenStore', () => {
  it('round-trips with owner-only permissions and clears credentials', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'nested', 'oauth.json')
    const store = new LinuxFileTokenStore(path)
    const credentials = {
      accessToken: 'access-super-secret',
      refreshToken: 'refresh-super-secret',
      expiresAt: Date.now() + 60_000,
      accountId: 'account-id',
    }

    await store.save(credentials)
    expect(await store.load()).toEqual(credentials)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, 'nested'))).mode & 0o777).toBe(0o700)
    expect(await readFile(path, 'utf8')).toContain('access-super-secret')
    expect(store.storage).toEqual({ kind: 'linux-file', encrypted: false })
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  it('refuses credential files readable by another user class', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'oauth.json')
    await writeFile(path, JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', expiresAt: 1 }))
    await chmod(path, 0o644)

    await expect(new LinuxFileTokenStore(path).load()).rejects.toThrow('invalid or insecure')
  })

  it('refuses to follow a credential symlink', async () => {
    const directory = await temporaryDirectory()
    const target = join(directory, 'target.json')
    const path = join(directory, 'oauth.json')
    await writeFile(target, JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', expiresAt: 1 }), { mode: 0o600 })
    await symlink(target, path)
    expect((await lstat(path)).isSymbolicLink()).toBe(true)

    await expect(new LinuxFileTokenStore(path).load()).rejects.toThrow('Linux credential read failed')
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-codex-linux-'))
  temporaryDirectories.push(directory)
  return directory
}
