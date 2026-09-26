export const STYLE_ID = 'dsh-claude-settings-style'

/**
 * Claude-only additions to the shared settings design system.
 *
 * The base control styles ('.dsha-page', '.dsha-group', '.dsha-models', the
 * account card, the meters, the composer badge, …) come from the stylesheet the
 * Kimi Code sibling installs, in the same order the client installs them, so
 * this file declares only what stays unique to this card — the same rule the
 * WorkBuddy and GLM cards follow.
 *
 * What stays unique here is the sign-in flow block and the borrowed-sign-in
 * markers, neither of which a sibling line renders.
 */
export function installClaudeStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dsha-badge.claude-adopted{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 16%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 45%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
.dshcl-flow{border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:10px;padding:12px 0}
.dshcl-flow-url{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.14));border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere;padding:8px 10px;user-select:all}
.dshcl-paste{align-items:flex-start;display:flex;flex-direction:column;gap:8px}
.dshcl-paste-row{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
.dshcl-paste-row input{flex:1 1 260px;min-width:200px}
.dshcl-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}
.dshcl-model-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:5px}
.dshcl-empty-inline{color:var(--dsw-alias-label-tertiary);font-size:12px}
`
  document.head.append(style)
}
