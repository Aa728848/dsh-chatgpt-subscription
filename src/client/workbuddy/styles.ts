import { installPluginStyle } from '../common/plugin-style.ts'

export const STYLE_ID = 'dsh-workbuddy-settings-style'

/**
 * WorkBuddy-only additions to the shared settings design system.
 *
 * The base control styles ('.dsha-page', '.dsha-group', '.dsha-models', the
 * account card, the composer badge, …) come from the stylesheet the sibling
 * routes install, in the same order the client installs them, so this file
 * declares only what stays unique to this card: the mono credential domain, the
 * login-progress action row, the guardrail/at-rest controls and the whole-pool
 * state banner.
 *
 * Two rules hold for everything here, and both are cheap to break by accident:
 *
 *   - every selector this line introduces is 'dsh-wb-'-prefixed, so it cannot
 *     collide with a sibling line's class of the same name;
 *   - nothing here redefines a shared primitive. A '.dsha-' selector may only
 *     appear as the shared class this card actually renders, never as a new
 *     definition — the shared sheet is the one place a primitive is described.
 */
export function installWorkBuddyStyles(): void {
  installPluginStyle('workbuddy', `
.dsh-wb-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.dsha-account-add-actions{display:flex;flex-wrap:wrap;gap:8px}
.dsha-account-add-actions .dsha-btn{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent;color:var(--dsw-alias-button-info-label,#fff)}
.dsha-account-add-actions .dsha-btn:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-button-info-fill,#397ee8)}
/* The whole-pool state banner. It renders BEFORE the account list on purpose:
   a paused pool means nothing is routable, and a list of green account cards
   above that sentence reads as "available" whatever the banner says. */
.dsh-wb-pool{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;display:flex;flex-direction:column;gap:4px;margin:0 0 14px;padding:10px 12px}
.dsh-wb-pool-title{align-items:center;display:flex;font-size:12px;font-weight:600;gap:8px}
.dsh-wb-pool-body{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dsh-wb-pool-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-wb-pool--paused{border-color:color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 45%,var(--dsw-alias-border-l2))}
.dsh-wb-pool--paused .dsh-wb-pool-title{color:var(--dsw-alias-label-danger,#d94b4b)}
/* One marker per account row, drawn inside the shared detail block: the row
   itself belongs to the shared card, and a second card-level badge would need
   the shared component taught a vocabulary it does not have. */
.dsh-wb-flag{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-wb-flag--park{color:var(--dsw-alias-label-warning,#d9913b)}
.dsh-wb-parks{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.dsh-wb-park{border:0.5px solid color-mix(in srgb,var(--dsw-alias-label-warning,#d9913b) 45%,transparent);border-radius:999px;color:var(--dsw-alias-label-warning,#d9913b);font-size:11px;padding:1px 7px}
/* Guardrails: one field per line, label left and control right — the same
   rhythm the context-window rows use, without a divider per row. Deliberately
   NOT .dsha-pref-row (a 58px full-width row with a border under it). */
.dsh-wb-fields{display:grid;gap:10px;margin:10px 0 14px}
.dsh-wb-field{align-items:center;display:flex;font-size:12px;gap:12px;justify-content:space-between}
.dsh-wb-control{align-items:center;display:flex;gap:8px}
.dsh-wb-control input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;padding:7px 9px;width:120px;text-align:right;box-sizing:border-box}
.dsh-wb-control input:disabled{opacity:.5}
.dsh-wb-control small{color:var(--dsw-alias-label-tertiary);font-size:11px;width:52px;text-align:left}
/* One control row: a flexible input with its actions beside it, never wrapped
   into two ragged lines. */
.dsh-wb-inputrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 14px}
.dsh-wb-inputrow>input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 9px;flex:1 1 260px;min-width:220px;max-width:420px;box-sizing:border-box}
.dsh-wb-inputrow>input:disabled{opacity:.5}

`, STYLE_ID)
}
