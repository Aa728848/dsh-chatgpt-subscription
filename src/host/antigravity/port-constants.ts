/**
 * Loopback callback ports for provider sign-in flows.
 *
 * Windows (Hyper-V/WinNAT) dynamically reserves TCP port ranges that change on
 * every reboot. A fixed callback port can land inside one and `listen` fails
 * with `EACCES` — browser authorization never opens. Flows therefore probe for
 * a usable port instead of assuming the default is free; the redirect URI the
 * provider receives carries whichever port was probed.
 */

/** Default loopback port the Antigravity CLI's own flow uses. */
export const DEFAULT_CALLBACK_PORT = 51121

/**
 * How many consecutive ports one probe covers.
 *
 * Windows excluded-port ranges are reserved in blocks of up to 100 ports, so a
 * probe narrower than that can stop inside a block and still fail. 128 covers
 * any single block the default port can start in.
 */
export const CALLBACK_PORT_ATTEMPTS = 128
