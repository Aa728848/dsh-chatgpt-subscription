/**
 * Styles for the shared ModelChecklist (see ModelChecklist.tsx). Row metrics
 * and hover follow the claude-style model picker so the settings list and the
 * conversation picker read as one surface.
 */
import { installPluginStyle } from './plugin-style.ts'

const CSS = `
.dsh-mcl{display:flex;flex-direction:column;min-width:0;padding:4px 0 2px}
.dsh-mcl-head{align-items:center;display:flex;justify-content:space-between;min-height:28px;padding:2px 2px 6px}
.dsh-mcl-count{color:var(--dsw-alias-label-caption,#a6a094);font-size:11px;letter-spacing:.02em}
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
`

export function installModelChecklistStyles(): void {
  installPluginStyle('model-checklist', CSS)
}
