import { describe, expect, it } from 'vitest'
import { ResponsesWebSocketTransport, type SocketLike } from '../src/host/responses-websocket.ts'

class FakeSocket implements SocketLike {
  readyState = 1
  closed = false
  close(): void { this.closed = true }
}

function transport(overrides: {
  socketFactory?: (url: string, headers: Record<string, string>) => Promise<SocketLike>
  idleTimeoutMs?: number
} = {}) {
  const opened: Array<{ url: string; headers: Record<string, string> }> = []
  const sockets: FakeSocket[] = []
  const value = new ResponsesWebSocketTransport({
    url: 'wss://example.invalid/responses',
    headers: () => ({ authorization: 'Bearer test' }),
    socketFactory: overrides.socketFactory ?? (async (url, headers) => {
      opened.push({ url, headers })
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    }),
    ...(overrides.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: overrides.idleTimeoutMs }),
  })
  return { value, opened, sockets }
}

describe('responses websocket transport', () => {
  it('reuses one socket per session', async () => {
    const { value, opened } = transport()

    const first = await value.connect('s1', 'account-a')
    const second = await value.connect('s1', 'account-a')

    expect(first).toBe(second)
    expect(opened).toHaveLength(1)
    expect(value.openSessions).toBe(1)
  })

  it('never reuses a connection opened by another account', async () => {
    const { value, sockets } = transport()

    const first = await value.connect('s1', 'account-a')
    const second = await value.connect('s1', 'account-b')

    // The rotated account gets a socket of its own; the old one is closed rather
    // than left dangling for the process to keep alive.
    expect(second).not.toBe(first)
    expect(sockets[0]!.closed).toBe(true)
    expect(value.openSessions).toBe(1)
  })

  it('falls back instead of throwing when the endpoint refuses', async () => {
    const { value } = transport({
      socketFactory: async () => { throw new Error('no websocket here') },
    })

    await expect(value.connect('s1', 'account-a')).resolves.toBeUndefined()
  })

  it('stops retrying a session that keeps failing', async () => {
    let attempts = 0
    const { value } = transport({
      socketFactory: async () => {
        attempts += 1
        throw new Error('refused')
      },
    })

    // The threshold is two failures. A single failure is not enough, so the
    // second attempt is still made; after it the breaker is open.
    await value.connect('s1', 'account-a')
    expect(attempts).toBe(1)
    expect(value.isBreakerOpen('s1')).toBe(false)

    await value.connect('s1', 'account-a')
    expect(attempts).toBe(2)
    expect(value.failureState('s1')).toMatchObject({ count: 2 })
    expect(value.isBreakerOpen('s1')).toBe(true)

    // The next attempt is not even made.
    await value.connect('s1', 'account-a')
    expect(attempts).toBe(2)
  })

  it('a successful reuse clears earlier failures', async () => {
    let failNext = true
    const { value } = transport({
      socketFactory: async () => {
        if (failNext) {
          failNext = false
          throw new Error('refused once')
        }
        return new FakeSocket()
      },
    })

    expect(await value.connect('s1', 'account-a')).toBeUndefined()
    expect(await value.connect('s1', 'account-a')).toBeDefined()
    // Below the threshold and now healthy, so the next attempt still happens.
    expect(await value.connect('s1', 'account-a')).toBeDefined()
  })

  it('recycles an idle socket instead of leaking it', async () => {
    const { value, sockets } = transport({ idleTimeoutMs: 5 })

    await value.connect('s1', 'account-a')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(sockets[0]!.closed).toBe(true)
    expect(value.openSessions).toBe(0)
  })
})