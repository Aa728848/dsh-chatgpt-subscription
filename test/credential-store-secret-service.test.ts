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

/** A credential whose JSON form exceeds secret-tool's 8192-byte stdin buffer. */
function oversized() {
  return { access: 'x'.repeat(9000), refresh: 'r' }
}

/** Run a chunked save with the mocked keyring; returns every captured stdin. */
async function saveChunked(instance: ReturnType<typeof store>, value: unknown) {
  const inputs: Array<() => string> = []
  inputs.push(commandResult(1)) // probe: nothing stored yet
  const payload = JSON.stringify(value)
  const chunks = Math.ceil(Buffer.from(payload, 'utf8').toString('base64').length / 7000)
  for (let index = 0; index < chunks; index += 1) inputs.push(commandResult(0)) // shards
  inputs.push(commandResult(0)) // envelope commit
  await instance.save(value)
  return inputs.map((read) => read())
}

describe('Linux Secret Service credential backend', () => {
  it('passes secret values only over stdin and parses lookup results', async () => {
    const credentials = { access: 'secret-access', refresh: 'secret-refresh' }
    commandResult(1) // probe: nothing stored yet
    const stdin = commandResult(0)
    await store().save(credentials)
    expect(stdin()).toBe(JSON.stringify(credentials))
    expect(spawn.mock.calls[1][1]).toEqual([
      'store', '--label=DSH dsh-antigravity', 'service', 'dsh-antigravity', 'account', 'test-account',
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
    commandResult(1) // probe: nothing stored yet
    commandResult(1, '', 'private-token')
    await expect(store().save({ access: 'private-token' })).rejects.toThrow('requires secret-tool')
    commandResult(0, 'private-invalid-json')
    await expect(store().load()).rejects.toThrow('credential payload is invalid')
  })

  it('probes before clearing and tolerates an already missing entry', async () => {
    commandResult(1)
    await store().clear()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1]).toEqual(['lookup', 'service', 'dsh-antigravity', 'account', 'test-account'])
    commandResult(1, '', 'locked')
    await expect(store().clear()).rejects.toThrow('requires secret-tool')
  })

  it('clears an existing entry after the probe finds one', async () => {
    commandResult(0, JSON.stringify({ access: 'a' }))
    commandResult(0)
    await store().clear()
    expect(spawn.mock.calls[1][1]).toEqual(['clear', 'service', 'dsh-antigravity', 'account', 'test-account'])
  })

  it('stores an oversized payload as shards plus an envelope and reads it back', async () => {
    const credentials = oversized()
    const instance = store()
    const inputs = await saveChunked(instance, credentials)
    const payload = JSON.stringify(credentials)

    // Probe first, then every shard under the 8192-byte limit, envelope last.
    expect(spawn.mock.calls[0][1][0]).toBe('lookup')
    const shardStdin = inputs.slice(1, -1)
    expect(shardStdin.length).toBe(2)
    for (const piece of shardStdin) expect(Buffer.byteLength(piece, 'utf8')).toBeLessThan(8192)
    expect(Buffer.from(shardStdin.join(''), 'base64').toString('utf8')).toBe(payload)

    const envelopeStdin = inputs[inputs.length - 1]
    const envelope = JSON.parse(envelopeStdin).__dshChunked as { gen: string; chunks: number; bytes: number }
    expect(envelope.chunks).toBe(2)
    expect(envelope.bytes).toBe(Buffer.byteLength(payload, 'utf8'))
    expect(Buffer.byteLength(envelopeStdin, 'utf8')).toBeLessThan(8192)
    // Shards are addressed under the generation the envelope names.
    for (let index = 0; index < envelope.chunks; index += 1) {
      expect(spawn.mock.calls[1 + index][1]).toEqual([
        'store', '--label=DSH dsh-antigravity',
        'service', 'dsh-antigravity', 'account', `test-account#${envelope.gen}#${index}`,
      ])
    }
    // The payload itself never appears in command arguments.
    expect(JSON.stringify(spawn.mock.calls)).not.toContain('xxxx')

    commandResult(0, envelopeStdin)
    for (const piece of shardStdin) commandResult(0, piece)
    expect(await store().load()).toEqual(credentials)
  })

  it('rejects a chunked value when one shard is missing or miscounted', async () => {
    const credentials = oversized()
    const instance = store()
    const inputs = await saveChunked(instance, credentials)
    const envelopeStdin = inputs[inputs.length - 1]

    commandResult(0, envelopeStdin)
    commandResult(0, inputs[1])
    commandResult(1) // second shard is gone
    await expect(store().load()).rejects.toThrow('credential payload is invalid')

    const tampered = JSON.stringify({
      __dshChunked: { ...(JSON.parse(envelopeStdin).__dshChunked as object), bytes: 1 },
    })
    commandResult(0, tampered)
    commandResult(0, inputs[1])
    commandResult(0, inputs[2])
    await expect(store().load()).rejects.toThrow('credential payload is invalid')
  })

  it('rejects a malformed envelope instead of serving it as a value', async () => {
    commandResult(0, JSON.stringify({ __dshChunked: { gen: '', chunks: 1, bytes: 1 } }))
    await expect(store().load()).rejects.toThrow('credential payload is invalid')
    commandResult(0, JSON.stringify({ __dshChunked: { gen: 'g', chunks: 9999, bytes: 1 } }))
    await expect(store().load()).rejects.toThrow('credential payload is invalid')
  })

  it('cleans up the previous shard generation once the new one is committed', async () => {
    const instance = store()
    const first = await saveChunked(instance, oversized())
    const firstGen = (JSON.parse(first[first.length - 1]).__dshChunked as { gen: string }).gen
    const firstChunks = 2
    spawn.mockClear()

    // Second chunked save: the probe reports the first generation's envelope.
    commandResult(0, first[first.length - 1])
    const secondInputs: Array<() => string> = []
    for (let index = 0; index < firstChunks; index += 1) secondInputs.push(commandResult(0))
    secondInputs.push(commandResult(0))
    commandResult(0) // clear first-gen shard 0
    commandResult(0) // clear first-gen shard 1
    await instance.save(oversized())

    const clears = spawn.mock.calls.filter((call) => call[1][0] === 'clear').map((call) => call[1] as string[])
    expect(clears).toEqual([
      ['clear', 'service', 'dsh-antigravity', 'account', `test-account#${firstGen}#0`],
      ['clear', 'service', 'dsh-antigravity', 'account', `test-account#${firstGen}#1`],
    ])
  })

  it('cleans up shards when a value shrinks back below the single-entry limit', async () => {
    const instance = store()
    const first = await saveChunked(instance, oversized())
    const envelope = JSON.parse(first[first.length - 1]).__dshChunked as { gen: string; chunks: number }
    spawn.mockClear()

    commandResult(0, first[first.length - 1]) // probe: chunked envelope
    commandResult(0) // single-entry store
    for (let index = 0; index < envelope.chunks; index += 1) commandResult(0) // shard clears
    await instance.save({ access: 'small' })

    const calls = spawn.mock.calls.map((call) => call[1] as string[])
    expect(calls[1][0]).toBe('store')
    expect(calls.slice(2)).toEqual([
      ['clear', 'service', 'dsh-antigravity', 'account', `test-account#${envelope.gen}#0`],
      ['clear', 'service', 'dsh-antigravity', 'account', `test-account#${envelope.gen}#1`],
    ])
  })

  it('removes the shards together with the entry on clear', async () => {
    const instance = store()
    const inputs = await saveChunked(instance, oversized())
    const envelope = JSON.parse(inputs[inputs.length - 1]).__dshChunked as { gen: string; chunks: number }
    spawn.mockClear()

    commandResult(0, inputs[inputs.length - 1]) // probe finds the envelope
    commandResult(0) // clear shard 0
    commandResult(0) // clear shard 1
    commandResult(0) // clear primary
    await store().clear()

    const calls = spawn.mock.calls.map((call) => call[1] as string[])
    expect(calls).toEqual([
      ['lookup', 'service', 'dsh-antigravity', 'account', 'test-account'],
      ['clear', 'service', 'dsh-antigravity', 'account', `test-account#${envelope.gen}#0`],
      ['clear', 'service', 'dsh-antigravity', 'account', `test-account#${envelope.gen}#1`],
      ['clear', 'service', 'dsh-antigravity', 'account', 'test-account'],
    ])
  })

  it('keeps the previous content when a shard write fails mid-save', async () => {
    commandResult(1) // probe: nothing stored yet
    commandResult(0) // first shard lands
    commandResult(1, '', 'keyring locked') // second shard fails
    commandResult(0) // rollback of the first shard
    await expect(store().save(oversized())).rejects.toThrow('requires secret-tool')
    const calls = spawn.mock.calls.map((call) => call[1] as string[])
    // The primary entry was never touched: no envelope commit happened.
    expect(calls.filter((call) => call[0] === 'store' && call[5] === 'test-account')).toEqual([])
  })
})
