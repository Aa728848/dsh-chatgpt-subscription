import { describe, expect, it, vi } from 'vitest'

// The resolver is the one thing here that reaches the network, so it is the one thing stubbed:
// a name this machine cannot resolve must not fail a request the proxy could have served.
const dns = vi.hoisted(() => ({ fail: true }))
vi.mock('node:dns/promises', () => ({
  lookup: async () => {
    if (dns.fail) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    return [{ address: '93.184.216.34', family: 4 }]
  },
}))

import {
  assertPublicFetchTarget,
  isIpLiteral,
  isNonPublicIpLiteral,
  isProxyFakeIpAddress,
  isPublicIpAddress,
  lookupHostAddresses,
} from '../src/host/fetch-address-policy.ts'

describe('isPublicIpAddress', () => {
  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '11.0.0.1',
    '172.15.255.255',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.1',
  ])('accepts the public IPv4 address %s', address => {
    expect(isPublicIpAddress(address)).toBe(true)
  })

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.17',
    '198.19.255.254',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    'not-an-address',
  ])('refuses the non-public IPv4 address %s', address => {
    expect(isPublicIpAddress(address)).toBe(false)
  })

  it.each([
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '2400:3200::1',
    '3fff:1000::1',
    '::ffff:8.8.8.8',
  ])('accepts the public IPv6 address %s', address => {
    expect(isPublicIpAddress(address)).toBe(true)
  })

  it.each([
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456:789a::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '2001:db8::1',
    '2001::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    '2002::1',
    '3fff::1',
    '3fff:0fff:ffff::1',
    '64:ff9b::7f00:1',
  ])('refuses the non-public IPv6 address %s', address => {
    expect(isPublicIpAddress(address)).toBe(false)
  })
})

describe('isProxyFakeIpAddress', () => {
  it('accepts only the benchmarking range a proxy hands out for faked names', () => {
    expect(isProxyFakeIpAddress('198.18.0.17')).toBe(true)
    expect(isProxyFakeIpAddress('198.19.255.254')).toBe(true)
    expect(isProxyFakeIpAddress('::ffff:198.18.0.17')).toBe(true)
    expect(isProxyFakeIpAddress('198.17.255.255')).toBe(false)
    expect(isProxyFakeIpAddress('198.20.0.1')).toBe(false)
    expect(isProxyFakeIpAddress('10.0.0.1')).toBe(false)
    expect(isProxyFakeIpAddress('2001:db8::1')).toBe(false)
  })
})

describe('isIpLiteral / isNonPublicIpLiteral', () => {
  it('separates stated addresses from names', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true)
    expect(isIpLiteral('[::1]')).toBe(true)
    expect(isIpLiteral('example.com')).toBe(false)
  })

  it('refuses a stated address that is not public', () => {
    expect(isNonPublicIpLiteral('127.0.0.1')).toBe(true)
    expect(isNonPublicIpLiteral('[::1]')).toBe(true)
    expect(isNonPublicIpLiteral('169.254.169.254')).toBe(true)
    expect(isNonPublicIpLiteral('198.18.0.17')).toBe(true)
    expect(isNonPublicIpLiteral('8.8.8.8')).toBe(false)
    expect(isNonPublicIpLiteral('example.com')).toBe(false)
  })
})

describe('assertPublicFetchTarget', () => {
  it('accepts a public answer', () => {
    expect(() => assertPublicFetchTarget('example.com', ['93.184.216.34'])).not.toThrow()
  })

  it('accepts the proxy fake-ip answer a proxied machine resolves names to', () => {
    expect(() => assertPublicFetchTarget('api.github.com', ['198.18.0.17'])).not.toThrow()
  })

  it('accepts an empty answer, leaving the name to the proxy that resolves the origin', () => {
    expect(() => assertPublicFetchTarget('internal.example', [])).not.toThrow()
  })

  it('refuses a stated non-public address', () => {
    expect(() => assertPublicFetchTarget('127.0.0.1', [])).toThrowError(/is not a public IP address/)
    expect(() => assertPublicFetchTarget('127.0.0.1', [])).toThrowError(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('refuses a name this machine resolves into private space', () => {
    expect(() => assertPublicFetchTarget('metadata.example', ['169.254.169.254']))
      .toThrowError(/resolves to a non-public IP address/)
  })

  it('refuses when any single answer is private', () => {
    expect(() => assertPublicFetchTarget('dual.example', ['93.184.216.34', '10.0.0.5'])).toThrowError(/non-public IP address/)
  })
})

describe('lookupHostAddresses', () => {
  it('returns an empty list instead of failing when the name does not resolve', async () => {
    dns.fail = true
    await expect(lookupHostAddresses('unresolvable.test')).resolves.toEqual([])
  })

  it('returns every address the resolver reported', async () => {
    dns.fail = false
    await expect(lookupHostAddresses('example.test')).resolves.toEqual(['93.184.216.34'])
  })
})
