import { installPluginStyle } from '../common/plugin-style.ts'
export const STYLE_ID = 'dsh-qianwen-token-plan-settings-style'
export function installQianwenStyles(): void {
  installPluginStyle('qianwen-token-plan', `
/* 输入行与上方 .dsha-row / .dsha-pref-row 的底部分界线保持间距，避免框线重合 */
.dshqw-key-row{align-items:stretch;display:grid;gap:8px;grid-template-columns:minmax(0,1fr) auto;margin-top:10px;width:100%}
.dshqw-vision-row{grid-template-columns:minmax(0,1fr) auto auto}
.dshqw-key-row input{box-sizing:border-box;display:block;height:32px;max-width:none;min-width:0;width:100%}
.dshqw-key-row .dsha-btn{align-items:center;display:inline-flex;height:32px;justify-content:center;min-width:80px;white-space:nowrap}
@media(max-width:640px){
.dshqw-key-row,.dshqw-vision-row{grid-template-columns:minmax(0,1fr)}
.dshqw-key-row .dsha-btn{width:100%}
}
.dshqw-details{border-top:0.5px solid var(--dsw-alias-border-l2);padding:10px 0 2px}
.dshqw-details>summary{color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;list-style:none}
.dshqw-details>p{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;margin:9px 0 0}
.dshqw-model-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:5px}
`, STYLE_ID)
}
