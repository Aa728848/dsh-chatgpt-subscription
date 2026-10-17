import { describe, expect, it, vi } from 'vitest'
import { webServerOrigin } from '../src/host/common/webserver-compat.ts'

describe('webServerOrigin', () => {
  it('uses the harness origin when the running web server provides it', () => {
    const getOrigin = vi.fn(() => 'https://[::1]:4443')
    expect(webServerOrigin({ host: '::1', port: undefined, getOrigin })).toBe('https://[::1]:4443')
    expect(getOrigin).toHaveBeenCalledOnce()
  })

  it.each([
    ['127.0.0.1', 'http://127.0.0.1:3080'],
    ['0.0.0.0', 'http://127.0.0.1:3080'],
  ])('keeps the legacy fallback for host %s', (host, expected) => {
    expect(webServerOrigin({ host, port: 3080 })).toBe(expected)
  })

  it('rejects an unbound legacy server instead of forming an invalid URL', () => {
    expect(() => webServerOrigin({ host: '127.0.0.1', port: undefined })).toThrow(
      'web server origin requested before the listener bound a port',
    )
  })
})
