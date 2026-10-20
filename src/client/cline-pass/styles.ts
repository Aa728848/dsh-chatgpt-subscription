import { installPluginStyle } from '../common/plugin-style.ts'

/**
 * Cline Pass's own prefixed classes only: layout the shared `.dsha-*`
 * vocabulary has no expression for (channel chips, the pin row, the usage
 * grid, the history table). Everything else on the tab reuses the shared card.
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
.dshcp-keyform{display:flex;flex-direction:column;gap:8px;align-items:stretch;margin-top:8px}
.dshcp-keyrow{display:flex;gap:8px;flex-wrap:wrap}
.dshcp-keyrow .dsha-input{flex:1;min-width:180px}
.dshcp-model{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;margin-top:8px;padding:0 12px}
.dshcp-model>summary{cursor:pointer;display:flex;align-items:center;gap:10px;list-style:none;padding:10px 0}
.dshcp-model>summary::-webkit-details-marker{display:none}
.dshcp-model-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcp-pill{border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;padding:1px 8px;color:var(--dsw-alias-label-secondary);flex:none}
.dshcp-pill[data-tone=ok]{color:var(--dsw-alias-label-success,#2e8b57);border-color:color-mix(in srgb,var(--dsw-alias-label-success,#2e8b57) 45%,transparent)}
.dshcp-pill[data-tone=warn]{color:var(--dsw-alias-label-warning,#d9913b);border-color:color-mix(in srgb,var(--dsw-alias-label-warning,#d9913b) 45%,transparent)}
.dshcp-pill[data-tone=danger]{color:var(--dsw-alias-label-danger,#d94b4b);border-color:color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 45%,transparent)}
.dshcp-body{border-top:0.5px solid var(--dsw-alias-border-l2);padding:12px 0;display:flex;flex-direction:column;gap:10px}
.dshcp-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dshcp-channels{display:flex;flex-wrap:wrap;gap:6px}
.dshcp-channel{display:inline-flex;align-items:center;gap:6px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;padding:3px 8px}
.dshcp-channel[data-pinned=true]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-1))}
.dshcp-channel[data-excluded=true]{opacity:.55;text-decoration:line-through}
.dshcp-channel[data-status=ok]{box-shadow:inset 3px 0 0 var(--dsw-alias-label-success,#2e8b57)}
.dshcp-channel[data-status=limited]{box-shadow:inset 3px 0 0 var(--dsw-alias-label-warning,#d9913b)}
.dshcp-channel[data-status=bad],.dshcp-channel[data-status=auth]{box-shadow:inset 3px 0 0 var(--dsw-alias-label-danger,#d94b4b)}
.dshcp-exclude{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1;padding:0 2px}
.dshcp-exclude:hover{color:var(--dsw-alias-label-danger,#d94b4b)}
.dshcp-pin-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.dshcp-pin-row label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshcp-actions{display:flex;gap:8px;flex-wrap:wrap}
.dshcp-warning{color:var(--dsw-alias-label-warning,#d9913b);font-size:12px}
.dshcp-trace{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:2px}

.dshcp-history{display:flex;flex-direction:column;gap:4px;margin-top:8px}
.dshcp-history-row{display:grid;grid-template-columns:150px minmax(120px,1fr) 130px 120px;gap:10px;font-size:12px;padding:5px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.dshcp-history-head{color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:none}
.dshcp-history-cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcp-history-error{color:var(--dsw-alias-label-danger,#d94b4b);grid-column:1/-1}
.dshcp-field{display:grid;grid-template-columns:minmax(160px,240px) minmax(0,1fr);gap:8px 14px;align-items:center;font-size:12.5px}
.dshcp-field .dsha-input{width:100%}
.dshcp-field-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
@media(max-width:720px){
  .dshcp-history-row{grid-template-columns:110px minmax(90px,1fr) 100px}
  .dshcp-history-row>:nth-child(4){display:none}
  .dshcp-field{grid-template-columns:1fr}
}
`)
}
