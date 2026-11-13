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
/* 折叠区：与 qoder / cline-pass 卡同一套写法——summary 是 12px 次要色、展开后正文同尺寸，
   details 默认不占版面。卡上只留一行结论，长句全部收进这里，不是删掉。 */
.dshagy-details{border-top:0.5px solid var(--dsw-alias-border-l2);padding:10px 0 2px}
.dshagy-details>summary{color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1.5;list-style:none;user-select:none}
.dshagy-details>summary::-webkit-details-marker{display:none}
.dshagy-details[open]>summary{color:var(--dsw-alias-label-primary)}
.dshagy-details>p{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;margin:9px 0 0}
.dshagy-boundary{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;margin:9px 0 0;padding-left:18px}
`, STYLE_ID)
}
