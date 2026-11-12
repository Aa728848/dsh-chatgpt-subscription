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
/* ---------- Shared account-pool card skeleton ----------
   The roster every provider's AccountPoolSection renders (list, card, header,
   identity, title, badges, details, actions). These rules used to live in the
   deleted src/client/antigravity/styles.ts and were injected by the now-removed
   installAntigravityStyles(); the line's removal took the whole sheet with it,
   so *every* line's account card lost its flex/gap/padding and collapsed onto
   itself. They are shared layout, not a per-line tweak, so they belong here in
   the pool sheet that is always installed. Values are restored verbatim from
   that sheet. Notes: the .dsha-badge base box lives in each line's own sheet
   (kimi/sibling); only the shared variant fills are kept here, and
   .dsha-badge.danger stays defined above in this same sheet. */
.dsha-accounts-list{display:flex;flex-direction:column;gap:10px;margin-top:10px}
.dsha-account-card{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;transition:border-color .15s ease}
.dsha-account-card.active{border-color:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 60%,var(--dsw-alias-border-l2))}
.dsha-account-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsha-account-identity{display:flex;align-items:center;gap:8px;min-width:0}
.dsha-account-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-badges{display:flex;align-items:center;gap:6px}
.dsha-badge.primary{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 18%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-button-info-fill,#397ee8);border:0.5px solid color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 40%,transparent)}
.dsha-badge.active{background:color-mix(in srgb,var(--dsw-alias-label-success,#10b981) 18%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-success,#10b981);border:0.5px solid color-mix(in srgb,var(--dsw-alias-label-success,#10b981) 40%,transparent)}
.dsha-badge.cooldown{background:color-mix(in srgb,var(--dsw-alias-label-warning,#d58a24) 18%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-warning,#d58a24);border:0.5px solid color-mix(in srgb,var(--dsw-alias-label-warning,#d58a24) 40%,transparent)}
.dsha-account-details{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsha-account-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.dsha-account-actions .dsha-btn{padding:5px 10px;font-size:12px}
`, POOL_STYLE_ID)
}
