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
export declare function lookupHostAddresses(hostname: string): Promise<readonly string[]>;
/**
 * Whether a host is stated as an IP address rather than as a name.
 *
 * @param hostname - a URL hostname, bracketed or not.
 * @returns true when the host is an IPv4 or IPv6 literal.
 */
export declare function isIpLiteral(hostname: string): boolean;
/**
 * Whether an address is one only a proxy's fake-ip resolver hands out. The IANA
 * benchmarking range carries no real host, so an answer inside it is this
 * machine's proxy claiming the name, not a private destination.
 *
 * @param address - a textual IPv4 (or IPv4-mapped IPv6) address.
 * @returns true when the address is inside the proxy fake-ip range.
 */
export declare function isProxyFakeIpAddress(address: string): boolean;
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
export declare function isPublicIpAddress(address: string): boolean;
/**
 * Whether a hostname is an IP literal no request may target.
 *
 * @param hostname - a URL hostname, bracketed or not.
 * @returns true when the host is a literal address that is not public.
 */
export declare function isNonPublicIpLiteral(hostname: string): boolean;
/**
 * Refuse a fetch destination the local network policy exists to keep out of
 * reach, before any request is made.
 *
 * @param hostname - the URL hostname, bracketed or not.
 * @param addresses - every address the local resolver returned for the host.
 * @throws WebError `WEB_BLOCKED_URL` for a non-public literal, or for a name
 *   this machine resolves into private space that is not the proxy's fake-ip.
 */
export declare function assertPublicFetchTarget(hostname: string, addresses: readonly string[]): void;
//# sourceMappingURL=fetch-address-policy.d.ts.map