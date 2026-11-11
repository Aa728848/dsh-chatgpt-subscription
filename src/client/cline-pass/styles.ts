import { installPluginStyle } from '../common/plugin-style.ts'

/**
 * Cline Pass's own prefixed classes only: layout the shared `.dsha-*`
 * vocabulary has no expression for (catalog chips, the model test panel and the
 * history table). Everything else on the tab reuses the shared card.
 */
export function installClinePassStyles(): void {
  installPluginStyle('cline-pass', `
.dshcp-flow{border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:8px;margin-top:10px;padding-top:10px}
.dshcp-login-row{align-items:center;display:flex;gap:12px;flex-wrap:wrap;margin:4px 0}
.dshcp-login-code{border:0.5px solid var(--dsw-alias-brand-primary);border-radius:8px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;font-weight:700;letter-spacing:.18em;padding:6px 14px}
.dshcp-paste{align-items:center;display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;margin-top:8px}
.dshcp-paste-note{font-size:12px}
.dshcp-details{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshcp-details>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none}
.dshcp-details ul{margin:6px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px}
.dsha-input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 10px;box-sizing:border-box}
.dsha-input:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
.dsha-input:disabled{opacity:.5}
.dshcp-keyform{display:flex;flex-direction:column;gap:8px;align-items:stretch;margin-top:8px}
.dshcp-keyrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.dshcp-keyrow .dsha-input{flex:1;min-width:180px}
.dshcp-model{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;margin-top:8px;padding:0 12px}
.dshcp-model>summary{cursor:pointer;display:flex;align-items:center;gap:10px;list-style:none;padding:10px 0}
.dshcp-model>summary::-webkit-details-marker{display:none}
.dshcp-model-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcp-pill{border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;padding:1px 8px;color:var(--dsw-alias-label-secondary);flex:none}
.dshcp-body{border-top:0.5px solid var(--dsw-alias-border-l2);padding:12px 0;display:flex;flex-direction:column;gap:10px}
.dshcp-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dshcp-channels{display:flex;flex-wrap:wrap;gap:6px}
.dshcp-channel{display:inline-flex;align-items:center;gap:6px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;padding:3px 8px}
.dshcp-exclude{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1;padding:0 2px}
.dshcp-exclude:hover{color:var(--dsw-alias-label-danger,#d94b4b)}
.dshcp-search-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.dshcp-search-row label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshcp-actions{display:flex;gap:8px;flex-wrap:wrap}
.dshcp-warning{color:var(--dsw-alias-label-warning,#d9913b);font-size:12px}

.dshcp-history{display:flex;flex-direction:column;gap:4px;margin-top:8px}
.dshcp-history-row{display:grid;grid-template-columns:150px minmax(120px,1fr) 130px 120px;gap:10px;font-size:12px;padding:5px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dshcp-history-head{color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:none}
.dshcp-history-cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcp-history-error{color:var(--dsw-alias-label-danger,#d94b4b);grid-column:1/-1}
.dshcp-adv-control{width:240px;max-width:100%;flex:none}
.dshcp-adv-control.dsha-select{max-width:240px;min-width:240px;width:240px}
.dshcp-adv-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.dshcp-adv-num{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-align:right;font-variant-numeric:tabular-nums}
.dshcp-check{flex:none;width:16px;height:16px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-button-info-fill,#397ee8)}
@media(max-width:720px){
  .dshcp-history-row{grid-template-columns:110px minmax(90px,1fr) 100px}
  .dshcp-history-row>:nth-child(4){display:none}
  .dshcp-adv-control,.dshcp-adv-control.dsha-select{width:100%;max-width:none;min-width:0}
}
`)
}
