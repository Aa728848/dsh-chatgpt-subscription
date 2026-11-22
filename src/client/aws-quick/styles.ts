import { installPluginStyle } from '../common/plugin-style.ts'
export function installAwsQuickStyles():void{installPluginStyle('aws-quick',`
.dshaq-details{border-top:.5px solid var(--dsw-alias-border-l2);padding:10px 0 2px}
.dshaq-details>summary{color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1.5}
.dshaq-details>p{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;margin:9px 0 0}
`,'dsh-aws-quick-settings-style')}
