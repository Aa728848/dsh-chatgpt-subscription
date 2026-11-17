import { installPluginStyle } from '../common/plugin-style.ts'
export const STYLE_ID = 'dsh-qianwen-token-plan-settings-style'
export function installQianwenStyles(): void {
  installPluginStyle('qianwen-token-plan', `
.dshqw-key-row{align-items:stretch;display:grid;gap:8px;grid-template-columns:minmax(0,1fr) auto;width:100%}
.dshqw-vision-row{grid-template-columns:minmax(0,1fr) auto auto}
.dshqw-key-row input{box-sizing:border-box;display:block;height:32px;max-width:none;min-width:0;width:100%}
.dshqw-key-row .dsha-btn{align-items:center;display:inline-flex;height:32px;justify-content:center;min-width:80px;white-space:nowrap}
@media(max-width:640px){
.dshqw-key-row,.dshqw-vision-row{grid-template-columns:minmax(0,1fr)}
.dshqw-key-row .dsha-btn{width:100%}
}
.dshqw-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:9px 18px;margin-top:10px}
.dshqw-stat{display:flex;flex-direction:column;gap:3px;min-width:0}
.dshqw-stat>span:first-child{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshqw-stat>span:last-child{color:var(--dsw-alias-label-primary);font-size:12px;white-space:nowrap}
.dshqw-details{border-top:0.5px solid var(--dsw-alias-border-l2);padding:10px 0 2px}
.dshqw-details>summary{color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;list-style:none}
.dshqw-details>p{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;margin:9px 0 0}
.dshqw-model-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:5px}
`, STYLE_ID)
}
