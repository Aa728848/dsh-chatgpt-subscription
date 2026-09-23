export const STYLE_ID = 'dsh-zhipu-settings-style'

/**
 * GLM Coding Plan additions to the shared settings design system.
 *
 * The base control styles (`.dsha-page`, `.dsha-group`, `.dsha-models`, the
 * account card, the meters, …) come from the stylesheets the sibling routes
 * install, in the same order the client installs them, so this file declares
 * only what stays unique to this card: the key-hint line and the region
 * selector that sits beside the key input.
 */
export function installZhipuStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dshzp-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.dshzp-keyrow{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dshzp-keyrow .dsha-select{min-width:190px}
.dshzp-keyrow input[type=password]{flex:1 1 260px;min-width:200px}
.dshzp-keyrow input[type=text]{flex:1 1 320px;min-width:220px}
.dshzp-login{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}
`
  document.head.append(style)
}
