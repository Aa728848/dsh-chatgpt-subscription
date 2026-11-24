/**
 * Styles for the shared ModelChecklist (see ModelChecklist.tsx). Row metrics
 * and hover follow the claude-style model picker so the settings list and the
 * conversation picker read as one surface.
 */
import { installPluginStyle } from './plugin-style.ts'

const CSS = `
.dsh-mcl{display:flex;flex-direction:column;min-width:0;padding:4px 0 2px}
.dsh-mcl-head{align-items:center;display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;min-height:28px;padding:2px 2px 6px}
.dsh-mcl-count{color:var(--dsw-alias-label-caption,#a6a094);font-size:11px;letter-spacing:.02em;margin-right:auto}
.dsh-mcl-search{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:7px;color:var(--dsw-alias-label-primary,#141413);font:inherit;font-size:12px;height:26px;max-width:210px;min-width:130px;outline:none;padding:0 9px;transition:border-color .15s ease;width:180px}
.dsh-mcl-search::placeholder{color:var(--dsw-alias-label-caption,#a6a094)}
.dsh-mcl-search:focus{border-color:var(--dsw-alias-button-info-fill,#397ee8)}
.dsh-mcl-head-actions{display:inline-flex;gap:4px}
.dsh-mcl-action{background:transparent;border:none;border-radius:5px;color:var(--dsw-alias-label-link,#3278d4);cursor:pointer;font:inherit;font-size:12px;padding:3px 7px}
.dsh-mcl-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dsh-mcl-action:disabled{cursor:default;opacity:.45}
.dsh-mcl-action:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-mcl-list{display:flex;flex-direction:column;gap:1px}
.dsh-mcl-option{align-items:center;background:transparent;border:none;border-radius:6px;color:var(--dsw-alias-label-primary,#141413);cursor:pointer;display:flex;font:inherit;gap:9px;min-height:34px;padding:3px 8px;text-align:left;width:100%}
.dsh-mcl-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-mcl-option:disabled{cursor:default;opacity:.55}
.dsh-mcl-option:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:-2px}
.dsh-mcl-option>svg{flex:none}
.dsh-mcl-copy{display:flex;flex:1;flex-direction:column;gap:1px;min-width:0}
.dsh-mcl-name{font-size:13px;font-weight:500;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcl-hint{color:var(--dsw-alias-label-tertiary,#8f8d84);font-size:11px;line-height:14px}
.dsh-mcl-option[data-enabled=false] .dsh-mcl-name,.dsh-mcl-option[data-enabled=false] .dsh-mcl-hint{opacity:.6}
.dsh-mcl-check{align-items:center;background:var(--dsw-alias-bg-layer-2,#f2f1ea);border:0.5px solid var(--dsw-alias-border-l1,#e8e6dc);border-radius:50%;color:transparent;display:inline-flex;flex:none;height:18px;justify-content:center;transition:background .12s ease,border-color .12s ease,color .12s ease;width:18px}
.dsh-mcl-option[aria-checked=true] .dsh-mcl-check{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent;color:var(--dsw-alias-button-info-label,#fff)}
.dsh-mcl-option:hover:not(:disabled) .dsh-mcl-check{border-color:var(--dsw-alias-button-info-fill,#397ee8)}
.dsh-mcl-split{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:10px;display:grid;grid-template-columns:174px minmax(0,1fr);height:380px;min-height:220px;overflow:hidden}
.dsh-mcl-vendors{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.025));border-right:0.5px solid var(--dsw-alias-border-l2,#e3e1d5);display:flex;flex-direction:column;gap:2px;min-height:0;overflow-y:auto;padding:6px}
.dsh-mcl-vendor{align-items:center;background:transparent;border:none;border-radius:6px;color:var(--dsw-alias-label-secondary,#5d5c52);cursor:pointer;display:flex;flex:none;font:inherit;font-size:12.5px;gap:7px;min-height:30px;padding:4px 8px;text-align:left;transition:background .12s ease,color .12s ease;width:100%}
.dsh-mcl-vendor:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#141413)}
.dsh-mcl-vendor[aria-selected=true]{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 15%,transparent);color:var(--dsw-alias-label-primary,#141413);font-weight:600}
.dsh-mcl-vendor:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:-2px}
.dsh-mcl-vendor>svg{flex:none}
.dsh-mcl-vendor-mono{align-items:center;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.07));border-radius:4px;color:var(--dsw-alias-label-secondary,#5d5c52);display:inline-flex;flex:none;font-size:10px;font-weight:650;height:14px;justify-content:center;width:14px}
.dsh-mcl-vendor-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcl-vendor-count{color:var(--dsw-alias-label-caption,#a6a094);flex:none;font-size:11px;font-variant-numeric:tabular-nums}
.dsh-mcl-vendor-count[data-has-enabled=true]{color:var(--dsw-alias-button-info-fill,#397ee8);font-weight:600}
.dsh-mcl-vendor-sep{background:var(--dsw-alias-border-l2,#e3e1d5);flex:none;height:1px;margin:4px 4px;opacity:.65}
.dsh-mcl-pane{display:flex;flex-direction:column;min-height:0;min-width:0}
.dsh-mcl-pane-head{align-items:center;border-bottom:0.5px solid var(--dsw-alias-border-l2,#e3e1d5);display:flex;flex:none;gap:8px;justify-content:space-between;min-height:36px;padding:4px 10px 4px 12px}
.dsh-mcl-pane-title{align-items:baseline;color:var(--dsw-alias-label-primary,#141413);display:inline-flex;font-size:12.5px;font-weight:600;gap:7px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcl-pane-sub{color:var(--dsw-alias-label-caption,#a6a094);font-size:11px;font-variant-numeric:tabular-nums;font-weight:400}
.dsh-mcl-pane-body{flex:1;min-height:0;overflow-y:auto;padding:4px 6px}
.dsh-mcl-empty{color:var(--dsw-alias-label-tertiary,#8f8d84);font-size:12.5px;margin:0;padding:18px 10px;text-align:center}
@media(max-width:560px){.dsh-mcl-split{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);height:420px}.dsh-mcl-vendors{border-bottom:0.5px solid var(--dsw-alias-border-l2,#e3e1d5);border-right:none;flex-direction:row;overflow-x:auto;overflow-y:hidden}.dsh-mcl-vendor{width:auto}.dsh-mcl-vendor-sep{height:18px;margin:auto 2px;width:1px}.dsh-mcl-search{flex:1;max-width:none;width:auto}}
`

export function installModelChecklistStyles(): void {
  installPluginStyle('model-checklist', CSS)
}
