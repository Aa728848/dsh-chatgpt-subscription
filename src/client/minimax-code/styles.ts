export const STYLE_ID = 'dsh-minimax-code-settings-style'

/**
 * MiniMax Code-only additions to the shared settings design system.
 *
 * The base control styles (.dsha-page, .dsha-group, .dsha-row, .dsha-models,
 * the device-code box, the meter, the composer badge, ...) come from the
 * stylesheet the sibling routes install, in the same order the client installs
 * them, so this file declares only what stays unique to this card: the mono
 * credential path and the model-name list.
 */
export function installMinimaxCodeStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dshm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.dshm-model-list{display:flex;flex-wrap:wrap;gap:7px;padding-top:8px}
.dshm-model-list code{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:5px 8px;white-space:nowrap}
.dshm-quota-note{margin-top:12px}
`
  document.head.append(style)
}
