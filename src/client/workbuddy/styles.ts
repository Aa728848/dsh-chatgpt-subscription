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
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dshwb-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.dsha-account-add-actions{display:flex;flex-wrap:wrap;gap:8px}
.dsha-account-add-actions .dsha-btn{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent;color:var(--dsw-alias-button-info-label,#fff)}
.dsha-account-add-actions .dsha-btn:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-button-info-fill,#397ee8)}
`
  document.head.append(style)
}
