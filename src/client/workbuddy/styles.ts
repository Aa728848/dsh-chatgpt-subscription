import { installPluginStyle } from '../common/plugin-style.ts'

export const STYLE_ID = 'dsh-workbuddy-settings-style'

/**
 * WorkBuddy-only additions to the shared settings design system.
 *
 * The base control styles (`.dsha-page`, `.dsha-group`, `.dsha-models`, the
 * account card, …) come from the stylesheet the sibling routes install, in the
 * same order the client installs them, so this file declares only what stays
 * unique to this card: the mono credential paths and the login-progress line.
 *
 * Everything this tab used to declare locally — the per-model capability line
 * and the account-region headings — is gone: the model pill is name-only like
 * every sibling tab, and the account card is the shared one.
 */
export function installWorkBuddyStyles(): void {
  installPluginStyle('workbuddy', `
.dshwb-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.dsha-account-add-actions{display:flex;flex-wrap:wrap;gap:8px}
.dsha-account-add-actions .dsha-btn{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent;color:var(--dsw-alias-button-info-label,#fff)}
.dsha-account-add-actions .dsha-btn:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-button-info-fill,#397ee8)}
/* Guardrails: one field per line, label left and control right — the same
   rhythm the context-window rows use, without a divider per row. Deliberately
   NOT .dsha-pref-row (a 58px full-width row with a border under it). */
.dshwb-fields{display:grid;gap:10px;margin:10px 0 14px}
.dshwb-field{align-items:center;display:flex;font-size:12px;gap:12px;justify-content:space-between}
.dshwb-control{align-items:center;display:flex;gap:8px}
.dshwb-control input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;padding:7px 9px;width:120px;text-align:right;box-sizing:border-box}
.dshwb-control input:disabled{opacity:.5}
.dshwb-control small{color:var(--dsw-alias-label-tertiary);font-size:11px;width:52px;text-align:left}
/* One control row: a flexible input with its actions beside it, never wrapped
   into two ragged lines. */
.dshwb-inputrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0 14px}
.dshwb-inputrow>input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 9px;flex:1 1 260px;min-width:220px;max-width:420px;box-sizing:border-box}
.dshwb-inputrow>input:disabled{opacity:.5}

`, STYLE_ID)
}
