import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecretServiceCredentialStore } from '../src/host/credential-store-secret-service.ts'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))

afterEach(() => { vi.resetAllMocks() })

function commandResult(code: number, stdout = '', stderr = '', error?: Error) {
  let input = ''
  spawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    })
    child.stdin.on('data', (chunk) => { input += chunk.toString() })
    queueMicrotask(() => {
      if (error) return child.emit('error', error)
      child.stdout.end(stdout)
      child.stderr.end(stderr)
      child.emit('close', code)
    })
    return child
  })
  return () => input
}

function store() {
  return new SecretServiceCredentialStore('dsh-antigravity', 'test-account', (value) => value)
}

describe('Linux Secret Service credential backend', () => {
  it('passes secret values only over stdin and parses lookup results', async () => {
    const credentials = { access: 'secret-access', refresh: 'secret-refresh' }
    const stdin = commandResult(0)
    await store().save(credentials)
    expect(stdin()).toBe(JSON.stringify(credentials))
    expect(spawn.mock.calls[0][1]).toEqual([
      'store', '--label=DSH Antigravity OAuth', 'service', 'dsh-antigravity', 'account', 'test-account',
    ])
    expect(JSON.stringify(spawn.mock.calls)).not.toContain('secret-access')
    commandResult(0, JSON.stringify(credentials))
    expect(await store().load()).toEqual(credentials)
  })

  it('distinguishes a missing item from a locked or unavailable keyring', async () => {
    commandResult(1)
    expect(await store().load()).toBeNull()
    commandResult(1, '', 'keyring locked: private error text')
    await expect(store().load()).rejects.toThrow('requires secret-tool')
    commandResult(1, '', '', new Error('spawn secret-tool ENOENT'))
    await expect(store().load()).rejects.toThrow('requires secret-tool')
  })

  it('reports write errors and corrupt payloads without echoing secrets', async () => {
    commandResult(1, '', 'private-token')
    await expect(store().save({ access: 'private-token' })).rejects.toThrow('requires secret-tool')
    commandResult(0, 'private-invalid-json')
    await expect(store().load()).rejects.toThrow('credential payload is invalid')
  })

  it('clears only its service/account and tolerates an already missing entry', async () => {
    commandResult(1)
    await store().clear()
    expect(spawn.mock.calls[0][1]).toEqual(['clear', 'service', 'dsh-antigravity', 'account', 'test-account'])
    commandResult(1, '', 'locked')
    await expect(store().clear()).rejects.toThrow('requires secret-tool')
  })

  it('rejects payloads beyond secret-tool stdin capacity before invoking it', async () => {
    await expect(store().save({ access: 'x'.repeat(8192) })).rejects.toThrow('payload is too large')
    expect(spawn).not.toHaveBeenCalled()
  })
})
