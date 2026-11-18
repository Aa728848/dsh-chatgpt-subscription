import { installPluginStyle } from '../common/plugin-style.ts'
export const STYLE_ID = 'dsh-relayone-settings-style'
export function installRelayOneStyles(): void {
  installPluginStyle('relayone', `
.dshro-page{display:flex;flex-direction:column;gap:12px}
.dshro-key-row{align-items:stretch;display:grid;gap:8px;grid-template-columns:minmax(0,1fr) auto;margin-top:10px;width:100%}
.dshro-key-row input{box-sizing:border-box;display:block;height:32px;max-width:none;min-width:0;width:100%}
.dshro-key-row .dsha-btn{align-items:center;display:inline-flex;height:32px;justify-content:center;min-width:80px;white-space:nowrap}
.dshro-details{border-top:0.5px solid var(--dsw-alias-border-l2);margin-top:8px;padding:10px 0 2px;color:var(--dsw-alias-label-secondary,#888);font-size:12px}
.dshro-details>summary{cursor:pointer;list-style:none}
.dshro-details p{margin:9px 0 0;line-height:1.55}
.dshro-details a{margin-right:12px}
.dshro-media-row .dsha-select{min-width:180px;max-width:320px}
.dshro-model-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:6px}
@media(max-width:640px){
.dshro-key-row{grid-template-columns:minmax(0,1fr)}
.dshro-key-row .dsha-btn{width:100%}
.dshro-media-row{align-items:stretch;flex-direction:column}
.dshro-media-row .dsha-select{max-width:none;min-width:0;width:100%}
}
`, STYLE_ID)
}
