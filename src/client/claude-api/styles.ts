import { installPluginStyle } from '../common/plugin-style.ts'
export const STYLE_ID = 'dsh-claude-api-settings-style'
/** Only what the shared .dsha-* primitives do not cover; no shared class is declared here. */
export function installClaudeApiStyles(): void {
  installPluginStyle('claude-api', `
.dshca-page{display:flex;flex-direction:column;gap:12px}
.dshca-key-row{align-items:stretch;display:grid;gap:8px;grid-template-columns:minmax(0,1fr) auto;margin-top:10px;width:100%}
.dshca-key-row input{box-sizing:border-box;display:block;height:32px;max-width:none;min-width:0;width:100%}
.dshca-key-row .dsha-btn{align-items:center;display:inline-flex;height:32px;justify-content:center;min-width:80px;white-space:nowrap}
.dshca-endpoint-control{align-items:center;display:flex;flex:1 1 auto;gap:8px;justify-content:flex-end;min-width:0}
.dshca-endpoint-control input{flex:1 1 auto;max-width:340px;min-width:0}
.dshca-version{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshca-details{border-top:0.5px solid var(--dsw-alias-border-l2);margin-top:8px;padding:10px 0 2px;color:var(--dsw-alias-label-secondary,#888);font-size:12px}
.dshca-details>summary{cursor:pointer;list-style:none}
.dshca-details p{margin:9px 0 0;line-height:1.55}
@media(max-width:640px){
.dshca-key-row{grid-template-columns:minmax(0,1fr)}
.dshca-key-row .dsha-btn{width:100%}
.dshca-endpoint-row{align-items:stretch;flex-direction:column}
.dshca-endpoint-control{flex-wrap:wrap;justify-content:flex-start}
.dshca-endpoint-control input{flex-basis:100%;max-width:none}
}
`, STYLE_ID)
}
