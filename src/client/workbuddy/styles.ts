export const STYLE_ID = 'dsh-workbuddy-settings-style'

/**
 * WorkBuddy-only additions to the shared settings design system.
 *
 * The base control styles (`.dsha-page`, `.dsha-group`, `.dsha-models`, …) come
 * from the stylesheet the sibling routes install, so this file declares only
 * what is unique to this card: the per-model capability line and the
 * "unavailable in this region" treatment.
 */
export function installWorkBuddyStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dshwb-model{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshwb-model-meta{color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:400;line-height:1.3;white-space:nowrap}
.dsha-models input:checked+span .dshwb-model-meta{color:var(--dsw-alias-label-secondary)}
.dshwb-region{display:inline-flex;align-items:center;gap:4px}
.dshwb-muted-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:8px 0 0}
.dshwb-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
`
  document.head.append(style)
}
