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
 * How many consecutive ports one probe covers, starting at the default.
 *
 * An excluded range is not a block of fixed width. Windows reserves whatever
 * span Hyper-V/WinNAT/its own services hold, it moves on every reboot, and a
 * Windows 11 host was measured handing this line's default port 277 consecutive
 * excluded ports (51121-51397). A window narrower than the run the default
 * starts inside ends *inside* that run and then reports "no usable port" on a
 * machine where hundreds of free ports sit immediately behind it — so the width
 * of this window, not the width the probe assumes, is what keeps the flow
 * working.
 *
 * 1024 is roughly 3.7x the widest run measured, which is the margin that stops
 * this depending on any single host's layout, and it still ends at 52144, far
 * below the 65535 ceiling. The window is cheap because it is walked one failed
 * bind at a time: a rejected listen measured ~0.35ms here (277 probes in 96ms),
 * so even the full 1024-probe worst case — only reached when every port in the
 * window is unusable, immediately before the actionable error — costs ~0.36s
 * once per sign-in. The ordinary case stops at the first usable port.
 */
export const CALLBACK_PORT_ATTEMPTS = 1024
