import { installPluginStyle } from '../common/plugin-style.ts'

export const STYLE_ID = 'dsh-antigravity-acp-settings-style'

/**
 * The Antigravity (ACP) card's own styles.
 *
 * Shared styles are never declared twice: the model checklist (`.dsh-mcl-*`) comes
 * from the shared model-checklist stylesheet, the base controls (`.dsha-group`,
 * `.dsha-pref-row`, `.dsha-select`, the composer pill) from the siblings' installers,
 * and the account-card skeleton is not used at all here because this line owns no
 * account pool.
 *
 * What is left is the one block nothing else has: the runtime line that states
 * which executable is in force and where it came from.
 */
export function installAntigravityAcpStyles(): void {
  installPluginStyle('antigravity-acp', `
.dshagy-runtime{align-items:baseline;display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:4px}
.dshagy-runtime-kind{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}
.dshagy-runtime-path{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere;user-select:all}
.dshagy-boundary{margin:0;padding-left:18px}
`, STYLE_ID)
}
