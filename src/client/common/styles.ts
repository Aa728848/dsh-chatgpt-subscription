export const POOL_STYLE_ID = 'dsh-provider-pool-style'

/**
 * Styles the shared account-pool card adds on top of the existing provider
 * stylesheets: the badge variants no single provider tab owned before.
 *
 * Additive on purpose — the shared `.dsha-*` block and each provider's own
 * tweaks keep living in their own modules, in the order the client installs
 * them, so nothing that already rendered changes appearance.
 */
export function installPoolStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(POOL_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = POOL_STYLE_ID
  style.textContent = `
.dsha-badge.danger{background:color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 18%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-danger,#d94b4b);border:0.5px solid color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 40%,transparent)}
.dsha-account-card .dsha-btn.danger{color:var(--dsw-alias-label-danger,#d94b4b)}
`
  document.head.append(style)
}
