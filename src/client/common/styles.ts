import { installPluginStyle } from './plugin-style.ts'

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
  installPluginStyle('pool', `
.dsha-badge.danger{background:color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 18%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-danger,#d94b4b);border:0.5px solid color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 40%,transparent)}
.dsha-account-card .dsha-btn.danger{color:var(--dsw-alias-label-danger,#d94b4b)}
/* Quota inside one account row. It follows the account, so it sits with the
   account's identity, badges and timestamps rather than in a page-level block
   that could only ever describe whichever account was active when it was read. */
.dsha-account-quota{display:flex;flex-direction:column;gap:5px;margin-top:9px}
.dsha-account-quota-head{align-items:baseline;color:var(--dsw-alias-label-secondary);display:flex;font-size:11px;font-weight:600;gap:8px;letter-spacing:.02em}
.dsha-account-quota-head em{color:var(--dsw-alias-label-tertiary);font-style:normal;font-weight:400}
.dsha-account-quota-empty{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsha-account-quota-row{align-items:center;display:flex;font-size:12px;gap:8px}
.dsha-account-quota-name{color:var(--dsw-alias-label-secondary);flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The track is drawn even when nothing is used: an empty bar nobody can see
   leaves the row reading as a stray label next to a number. */
.dsha-account-quota-track{background:color-mix(in srgb,var(--dsw-alias-label-tertiary,#8a8a8a) 16%,transparent);border-radius:999px;box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l2);flex:1;height:6px;min-width:56px;overflow:hidden}
.dsha-account-quota-fill{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:999px;display:block;height:100%;min-width:2px;transition:width .2s ease}
.dsha-account-quota-row[data-level=warning] .dsha-account-quota-fill{background:var(--dsw-alias-label-warning,#d9913b)}
.dsha-account-quota-row[data-level=danger] .dsha-account-quota-fill{background:var(--dsw-alias-label-danger,#d94b4b)}
.dsha-account-quota-value{color:var(--dsw-alias-label-primary);flex:none;font-variant-numeric:tabular-nums;min-width:40px;text-align:right}
.dsha-account-quota-meta{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px;font-variant-numeric:tabular-nums}
@media(max-width:560px){.dsha-account-quota-meta{display:none}}
`, POOL_STYLE_ID)
}
