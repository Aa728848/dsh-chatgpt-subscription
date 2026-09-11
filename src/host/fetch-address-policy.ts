/**
 * Destination policy for this plugin's fetch provider.
 *
 * DSH's built-in provider resolves every destination and validates and pins the
 * address before it connects. That cannot work on a machine whose proxy answers
 * DNS with its own fake-ip range (`198.18.0.0/15` for Clash/Mihomo, the usual
 * companion of a system proxy): the hostname is ordinary, the answer is reserved
 * space, and every request is refused before the proxy that could have resolved
 * it is ever consulted. This provider exists for that machine, so it cannot
 * validate names the way the built-in one does.
 *
 * It keeps the half of the policy that needs no resolution — an address the URL
 * states outright is refused unless it is globally reachable unicast, because a
 * proxy on this machine must not become a path into loopback or a LAN — and it
 * also refuses a name this machine resolves into private space. Only the proxy's
 * own fake-ip answers are accepted, since that is what the proxy's name
 * resolution looks like from here; the URL hostname still reaches the proxy
 * intact, so the proxy decides where the name really goes.
 *
 * @module dsh-chatgpt-subscription/fetch-address-policy
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'

/**
 * Every IPv4 range a fetch may not target: "this network", private space,
 * carrier-grade NAT, loopback, link-local, IETF assignments, documentation,
 * the 6to4 relay anycast, the benchmarking range the mainstream proxy tools use
 * for fake-ip answers, multicast, and reserved space including the broadcast
 * address.
 */
const NON_PUBLIC_IPV4: readonly string[] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
]

/** The fake-ip range the mainstream proxy tools hand out for the names they own. */
const FAKE_IP_RANGE = '198.18.0.0/15'

/**
 * Resolve one hostname to every address the local resolver returns, or to no
 * addresses when it cannot.
 *
 * A failure is not evidence of a local destination: the configured proxy
 * resolves the origin itself, so a name this machine cannot resolve must not
 * fail a request the proxy could have served.
 *
 * @param hostname - the URL hostname, without brackets.
 * @returns the resolved addresses, or an empty list when resolution failed.
 */
export async function lookupHostAddresses(hostname: string): Promise<readonly string[]> {
  try {
    const answers = await lookup(hostname, { all: true, verbatim: true })
    return answers.map(answer => answer.address)
  } catch {
    return []
  }
}

/**
 * Whether a host is stated as an IP address rather than as a name.
 *
 * @param hostname - a URL hostname, bracketed or not.
 * @returns true when the host is an IPv4 or IPv6 literal.
 */
export function isIpLiteral(hostname: string): boolean {
  return isIP(unbracket(hostname)) !== 0
}

/**
 * Whether an address is one only a proxy's fake-ip resolver hands out. The IANA
 * benchmarking range carries no real host, so an answer inside it is this
 * machine's proxy claiming the name, not a private destination.
 *
 * @param address - a textual IPv4 (or IPv4-mapped IPv6) address.
 * @returns true when the address is inside the proxy fake-ip range.
 */
export function isProxyFakeIpAddress(address: string): boolean {
  const value = ipv4Value(unbracket(address).replace(/^::ffff:/i, ''))
  return value !== undefined && inRange(value, FAKE_IP_RANGE)
}

/**
 * Whether an address is globally reachable unicast. IPv4-mapped IPv6 is
 * classified by the IPv4 address it embeds; every other IPv6 address is public
 * only inside `2000::/3`, which excludes loopback, unique-local, link-local,
 * multicast, and the transition and translation prefixes whose real destination
 * cannot be seen from the address alone.
 *
 * @param address - a textual IPv4 or IPv6 address, bracketed or not.
 * @returns true only for a public unicast destination.
 */
export function isPublicIpAddress(address: string): boolean {
  const unbracketed = unbracket(address)
  const family = isIP(unbracketed)
  if (family === 4) return isPublicIpv4(unbracketed)
  if (family !== 6) return false
  const mapped = unbracketed.replace(/^::ffff:/i, '')
  if (isIP(mapped) === 4) return isPublicIpv4(mapped)
  return isPublicIpv6(unbracketed)
}

/**
 * Whether a hostname is an IP literal no request may target.
 *
 * @param hostname - a URL hostname, bracketed or not.
 * @returns true when the host is a literal address that is not public.
 */
export function isNonPublicIpLiteral(hostname: string): boolean {
  const unbracketed = unbracket(hostname)
  return isIP(unbracketed) !== 0 && !isPublicIpAddress(unbracketed)
}

/**
 * Refuse a fetch destination the local network policy exists to keep out of
 * reach, before any request is made.
 *
 * @param hostname - the URL hostname, bracketed or not.
 * @param addresses - every address the local resolver returned for the host.
 * @throws WebError `WEB_BLOCKED_URL` for a non-public literal, or for a name
 *   this machine resolves into private space that is not the proxy's fake-ip.
 */
export function assertPublicFetchTarget(hostname: string, addresses: readonly string[]): void {
  if (isNonPublicIpLiteral(hostname)) {
    throw new WebError(`URL hostname "${hostname}" is not a public IP address`, 'WEB_BLOCKED_URL')
  }
  for (const address of addresses) {
    if (isPublicIpAddress(address) || isProxyFakeIpAddress(address)) continue
    throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
  }
}

/** Whether a dotted quad is public, using {@link NON_PUBLIC_IPV4}. */
function isPublicIpv4(address: string): boolean {
  const value = ipv4Value(address)
  if (value === undefined) return false
  return !NON_PUBLIC_IPV4.some(cidr => inRange(value, cidr))
}

/** Whether a 32-bit address sits inside one `a.b.c.d/prefix` range. */
function inRange(value: number, cidr: string): boolean {
  const slash = cidr.indexOf('/')
  const network = ipv4Value(cidr.slice(0, slash))
  const prefix = Number(cidr.slice(slash + 1))
  if (network === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return ((value & mask) >>> 0) === ((network & mask) >>> 0)
}

/** Parse a dotted quad into its 32-bit value, or `undefined` when it is not one. */
function ipv4Value(address: string): number | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = ((value << 8) | octet) >>> 0
  }
  return value
}

/** Whether an IPv6 literal is inside `2000::/3` and outside its blocked sub-ranges. */
function isPublicIpv6(address: string): boolean {
  const words = ipv6Words(address)
  if (words === undefined) return false
  // `ipv6Words` returns exactly eight words, so the first two are always present.
  const [first = 0, second = 0] = words
  // Global unicast is 2000::/3, a prefix of the address's first three bits (high byte of word one).
  if (((first >> 8) & 0xe0) !== 0x20) return false
  if (first === 0x2001) {
    if (second === 0x0db8) return false                     // 2001:db8::/32 documentation
    if (second === 0x0000) return false                     // 2001::/32 Teredo
    if (second === 0x0002) return false                     // 2001:2::/48 benchmarking
    if ((second & 0xfff0) === 0x0010) return false          // 2001:10::/28 ORCHID
    if ((second & 0xfff0) === 0x0020) return false          // 2001:20::/28 ORCHIDv2
  }
  if (first === 0x2002) return false                        // 2002::/16 6to4
  if (first === 0x3fff && second <= 0x0fff) return false    // 3fff::/20 documentation
  return true
}

/** Parse an IPv6 literal into its eight 16-bit words, or `undefined` when it is not one. */
function ipv6Words(address: string): number[] | undefined {
  const zone = address.indexOf('%')
  const text = zone === -1 ? address : address.slice(0, zone)
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const head = parseIpv6Half(halves[0] ?? '')
  if (head === undefined) return undefined
  if (halves.length === 1) return head.length === 8 ? head : undefined
  const tail = parseIpv6Half(halves[1] ?? '')
  if (tail === undefined) return undefined
  const gap = 8 - head.length - tail.length
  // '::' stands for at least one omitted word, so a full head and tail cannot surround it.
  if (gap < 1) return undefined
  return [...head, ...new Array<number>(gap).fill(0), ...tail]
}

/** Parse one '::'-free half of an IPv6 literal, expanding a trailing dotted quad. */
function parseIpv6Half(segment: string): number[] | undefined {
  if (segment === '') return []
  const words: number[] = []
  for (const piece of segment.split(':')) {
    if (piece.includes('.')) {
      const value = ipv4Value(piece)
      if (value === undefined) return undefined
      words.push(value >>> 16, value & 0xffff)
      continue
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined
    words.push(parseInt(piece, 16))
  }
  return words
}

/** WHATWG URL keeps brackets around an IPv6 hostname; IP parsers do not. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}
