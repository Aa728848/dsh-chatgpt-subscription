/**
 * Regression tests for the mutation same-origin policy.
 *
 * The DSH Desktop shell admits only requests from its `dsh-app://app` document,
 * then removes the `origin` header before forwarding to the Host — that
 * application scheme is not an HTTP origin the Host could compare. The policy
 * used to require an `origin` unconditionally, so every guarded mutation from
 * the desktop application was rejected as cross-origin: browser authorization
 * could not even start, because its POST never reached the route.
 *
 * A missing `origin` is now accepted only for a loopback `Host`, while a stated
 * origin must still match exactly. These tests pin both halves: the desktop
 * shape passes, and every cross-site shape a browser can produce still fails.
 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isSameOriginMutation } from '../src/host/common/same-origin.ts'

/** Minimal request stub: the policy reads only these two headers. */
function request(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('isSameOriginMutation', () => {
  it('accepts a stated origin that matches the addressed authority', () => {
    expect(isSameOriginMutation(request({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }))).toBe(true)
    expect(isSameOriginMutation(request({ host: 'example.test', origin: 'https://example.test' }))).toBe(true)
    // Authority comparison is case-insensitive.
    expect(isSameOriginMutation(request({ host: 'EXAMPLE.test', origin: 'https://example.test' }))).toBe(true)
  })

  it('compares the authority exactly, default port included', () => {
    // The URL parser drops a default port from `origin`, so `https://h:443`
    // presents `h` while a Host header of `h:443` keeps it. This strictness
    // predates the missing-origin clause and is preserved: a browser omits the
    // default port from Host, so the two agree on every real request.
    expect(isSameOriginMutation(request({ host: 'example.test:443', origin: 'https://example.test:443' }))).toBe(false)
    expect(isSameOriginMutation(request({ host: 'example.test:443', origin: 'https://example.test' }))).toBe(false)
  })

  it('rejects a stated foreign origin', () => {
    // The CSRF shape: a page on another site posts to the loopback Host.
    expect(isSameOriginMutation(request({ host: '127.0.0.1:19387', origin: 'https://evil.example' }))).toBe(false)
    // A different port on the same host is a different origin.
    expect(isSameOriginMutation(request({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:9999' }))).toBe(false)
    // A look-alike suffix must not pass.
    expect(isSameOriginMutation(request({ host: 'example.test', origin: 'https://evil-example.test' }))).toBe(false)
  })

  it('rejects a stated origin that is not an HTTP origin', () => {
    // The desktop document's own scheme: the shell never forwards it as-is,
    // and treating it as same-origin would be meaningless to compare.
    expect(isSameOriginMutation(request({ host: '127.0.0.1:19387', origin: 'dsh-app://app' }))).toBe(false)
    expect(isSameOriginMutation(request({ host: '127.0.0.1:19387', origin: 'file:///tmp/x' }))).toBe(false)
    expect(isSameOriginMutation(request({ host: '127.0.0.1:19387', origin: 'not a url' }))).toBe(false)
  })

  it('accepts a missing origin on a loopback authority', () => {
    // The desktop forwarding shape: origin removed, Host loopback.
    expect(isSameOriginMutation(request({ host: '127.0.0.1:19387' }))).toBe(true)
    expect(isSameOriginMutation(request({ host: 'localhost:19387' }))).toBe(true)
    expect(isSameOriginMutation(request({ host: 'localhost' }))).toBe(true)
    expect(isSameOriginMutation(request({ host: '[::1]:19387' }))).toBe(true)
    expect(isSameOriginMutation(request({ host: '127.0.0.1' }))).toBe(true)
  })

  it('rejects a missing origin on a non-loopback authority', () => {
    // An exposed Host keeps the strict requirement: only a stated, matching
    // origin may mutate, so a bare non-browser client cannot skip the check.
    expect(isSameOriginMutation(request({ host: '192.168.1.5:19387' }))).toBe(false)
    expect(isSameOriginMutation(request({ host: '0.0.0.0:19387' }))).toBe(false)
    expect(isSameOriginMutation(request({ host: 'example.test' }))).toBe(false)
  })

  it('rejects a request with no host at all', () => {
    expect(isSameOriginMutation(request({ origin: 'http://127.0.0.1:19387' }))).toBe(false)
    expect(isSameOriginMutation(request({ host: '' }))).toBe(false)
    expect(isSameOriginMutation(request({ host: '', origin: '' }))).toBe(false)
    // An empty origin is the missing-origin shape, not a stated one.
    expect(isSameOriginMutation(request({ host: '127.0.0.1:19387', origin: '' }))).toBe(true)
  })
})