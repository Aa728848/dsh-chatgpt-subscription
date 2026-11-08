/** 派发卡片的样式表。 */
import { installPluginStyle } from '../common/plugin-style.ts'

const CSS = `
.dshc-mandate-root{margin:6px 0;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,0.03));overflow:hidden}
.dshc-mandate-root[data-state="error"]{border-color:var(--dsw-alias-border-danger,rgba(255,99,99,0.55))}
.dshc-mandate-row{display:flex;align-items:center;gap:8px;width:100%;margin:0;padding:6px 10px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshc-mandate-row[data-expandable="false"]{cursor:default}
.dshc-mandate-caret{flex:none;font-size:11px;opacity:.7;width:10px}
.dshc-mandate-title{flex:none;font-size:12px;font-weight:500}
.dshc-mandate-summary{flex:1;min-width:0;font-size:12px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshc-mandate-state{flex:none;font-size:11px;opacity:.75}
.dshc-mandate-body{display:flex;flex-direction:column;gap:8px;padding:2px 10px 10px}
.dshc-mandate-chips{display:flex;flex-wrap:wrap;gap:6px}
.dshc-mandate-chip{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1;padding:4px 6px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,0.14));border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.05));white-space:nowrap}
.dshc-mandate-label{opacity:.62;font-family:inherit;margin-right:5px}
.dshc-mandate-field{display:flex;gap:8px;font-size:12px;line-height:1.5}
.dshc-mandate-field-key{flex:none;min-width:64px;opacity:.62}
.dshc-mandate-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.dshc-mandate-list li{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;opacity:.86}
.dshc-mandate-text{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;margin:0}
.dshc-mandate-result{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,0.06))}
.dshc-mandate-result[data-error="true"]{color:var(--dsw-alias-label-danger,#ff8b8b);background:var(--dsw-alias-bg-danger,rgba(255,80,80,0.1))}
.dshc-mandate-raw{border:0;background:transparent;color:inherit;font:inherit;font-size:11px;opacity:.7;cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:2px}
.dshc-mandate-rawtext{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:0;max-height:260px;overflow:auto}
.dshc-mandate-note{font-size:11px;opacity:.6}
`

/** 安装样式（重复调用是幂等的）。 */
export function installDispatchLedgerStyles(): void {
  installPluginStyle('dispatch-ledger', CSS)
}
