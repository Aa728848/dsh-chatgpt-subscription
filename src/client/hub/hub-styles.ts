/**
 * Styles for the Magpie-inspired subscription hub: rounded provider list cards,
 * collapsible turned-off section, inline add-provider sheet, status pills,
 * batch selection bar, and context menu. Uses DSH theme tokens so light, dark,
 * and custom theme palettes work without hardcoded branches.
 */
import { installPluginStyle } from '../common/plugin-style.ts'

const CSS = `
.dsh-hub-overview{display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-hub-toolbar{align-items:center;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;margin:2px 0 4px;min-width:0}
.dsh-hub-head-tools{flex:0 1 auto;margin:0}
.dsh-hub-search{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:8px;color:var(--dsw-alias-label-primary,#141413);font:inherit;font-size:12.5px;height:28px;max-width:220px;min-width:140px;outline:none;padding:0 10px;transition:border-color .15s ease;width:200px}
.dsh-hub-search::placeholder{color:var(--dsw-alias-label-caption,#a6a094)}
.dsh-hub-search:focus{border-color:var(--dsw-alias-button-info-fill,#397ee8)}
.dsh-hub-tool-btn{align-items:center;background:transparent;border:none;border-radius:7px;color:var(--dsw-alias-label-secondary,#5d5c52);cursor:pointer;display:inline-flex;flex:none;font:inherit;font-size:12.5px;gap:5px;height:28px;padding:0 9px;transition:background .15s ease,color .15s ease}
.dsh-hub-tool-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#141413)}
.dsh-hub-tool-btn:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
.dsh-hub-tool-btn:disabled{cursor:default;opacity:.45}
.dsh-hub-tool-btn svg{display:block;flex:none}
.dsh-hub-sel-bar{align-items:center;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:10px;display:flex;flex-wrap:wrap;gap:6px;padding:7px 10px}
.dsh-hub-sel-count{color:var(--dsw-alias-label-secondary,#5d5c52);font-size:12.5px;font-weight:550;margin-right:auto}
.dsh-hub-list{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:12px;overflow:hidden}
.dsh-hub-row{align-items:center;background:transparent;border:none;color:var(--dsw-alias-label-primary,#141413);cursor:pointer;display:flex;gap:12px;min-height:58px;padding:10px 14px;position:relative;text-align:left;transition:background .14s ease;width:100%}
.dsh-hub-row+.dsh-hub-row{border-top:0.5px solid var(--dsw-alias-border-l2,#eceadf)}
.dsh-hub-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.035))}
.dsh-hub-row:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:-2px}
.dsh-hub-row[data-dragging=true]{opacity:.45}
.dsh-hub-row[data-drop-target=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));box-shadow:inset 0 2px var(--dsw-alias-button-info-fill,#397ee8)}
.dsh-hub-row[data-enabled=false] .dsh-hub-who,.dsh-hub-row[data-enabled=false] .dsh-hub-brand-tile,.dsh-hub-row[data-enabled=false] .dsh-hub-status{opacity:.58}
.dsh-hub-logo-handle{align-items:center;background:transparent;border:none;border-radius:9px;cursor:grab;display:inline-flex;flex:none;justify-content:center;padding:0;touch-action:none}
.dsh-hub-logo-handle:active{cursor:grabbing}
.dsh-hub-logo-handle:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-hub-check{accent-color:var(--dsw-alias-button-info-fill,#397ee8);cursor:pointer;flex:none;height:15px;margin:0 2px;width:15px}
.dsh-hub-who{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.dsh-hub-name-row{align-items:center;display:flex;flex-wrap:nowrap;gap:6px;min-width:0}
.dsh-hub-card-name{font-size:13.5px;font-weight:600;line-height:1.35;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-hub-badge{background:var(--dsw-alias-bg-layer-2,#f2f1ea);border-radius:4px;color:var(--dsw-alias-label-secondary,#5d5c52);flex:none;font-size:10.5px;font-weight:500;line-height:1.5;padding:0 5px;white-space:nowrap}
.dsh-hub-badge.is-off{color:var(--dsw-alias-label-tertiary,#8f8d84)}
.dsh-hub-badge.is-proxy{border:0.5px solid var(--dsw-alias-border-l2,#e3e1d5);color:var(--dsw-alias-label-tertiary,#8f8d84)}
.dsh-hub-card-note{color:var(--dsw-alias-label-tertiary,#8f8d84);font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-hub-card-note.dsh-hub-note-danger{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-hub-hits{color:var(--dsw-alias-label-secondary,#5d5c52);font-size:11.5px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-hub-status{align-items:center;border-radius:6px;color:var(--dsw-alias-label-secondary,#5d5c52);display:inline-flex;flex:none;font-size:12px;gap:6px;height:22px;max-width:168px;min-width:0;padding:0 8px}
.dsh-hub-status::before{background:#2ea043;border-radius:50%;content:"";flex:none;height:6px;width:6px}
.dsh-hub-status>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-hub-status.is-idle{color:var(--dsw-alias-label-caption,#a6a094)}
.dsh-hub-status.is-idle::before{background:var(--dsw-alias-label-caption,#a6a094)}
.dsh-hub-status.is-warn{background:color-mix(in srgb,#d97706 12%,transparent);color:#d97706}
.dsh-hub-status.is-warn::before{background:#d97706}
.dsh-hub-status.is-error{background:color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 12%,transparent);color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-hub-status.is-error::before{background:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-hub-tail{align-items:center;display:flex;flex:none;gap:10px}
.dsh-hub-chevron{color:var(--dsw-alias-label-caption,#a6a094);display:inline-flex;flex:none}
.dsh-hub-brand-tile{align-items:center;background:var(--dsh-hub-brand,#fff);border-radius:26%;box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.1);display:inline-flex;flex:none;justify-content:center;overflow:hidden}
.dsh-hub-brand-tile>svg{display:block}
.dsh-hub-brand-image{display:block;height:100%;width:100%}
.dsh-hub-brand-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-weight:700;line-height:1}
.dsh-hub-switch{background:var(--dsw-alias-bg-layer-2,#e5e4dd);border:0.5px solid var(--dsw-alias-border-l2,#d8d6cb);border-radius:999px;box-sizing:border-box;cursor:pointer;flex:none;height:22px;padding:2px;position:relative;transition:background .15s ease,border-color .15s ease;width:38px}
.dsh-hub-switch::after{background:var(--dsw-alias-bg-layer-1,#fff);border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,.26);content:"";display:block;height:17px;transition:transform .15s ease;width:17px}
.dsh-hub-switch[aria-checked=true]{background:var(--dsw-alias-button-info-fill,#18181b);border-color:transparent}
.dsh-hub-switch[aria-checked=true]::after{transform:translateX(16px)}
.dsh-hub-switch:disabled{cursor:default;opacity:.5}
.dsh-hub-switch:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-hub-off-head{align-items:center;display:flex;margin-top:4px;padding:0 2px}
.dsh-hub-fold{align-items:center;background:transparent;border:none;border-radius:6px;color:var(--dsw-alias-label-tertiary,#8f8d84);cursor:pointer;display:inline-flex;font:inherit;font-size:12px;gap:5px;padding:4px 8px 4px 4px;transition:background .14s ease,color .14s ease}
.dsh-hub-fold:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#141413)}
.dsh-hub-fold:disabled{cursor:default}
.dsh-hub-fold svg{flex:none;transition:transform .15s ease}
.dsh-hub-fold[aria-expanded=false] svg{transform:rotate(-90deg)}
.dsh-hub-fold-count{font-variant-numeric:tabular-nums;opacity:.85}
.dsh-hub-after-list{align-items:center;display:flex;gap:8px;padding:2px 2px 0}
.dsh-hub-add-btn{align-items:center;background:transparent;border:none;border-radius:7px;color:var(--dsw-alias-label-secondary,#5d5c52);cursor:pointer;display:inline-flex;font:inherit;font-size:13px;gap:5px;padding:6px 10px 6px 6px;transition:background .15s ease,color .15s ease}
.dsh-hub-add-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#141413)}
.dsh-hub-add-btn:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
.dsh-hub-sheet{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:12px;display:flex;flex-direction:column;gap:8px;padding:12px 14px 14px}
.dsh-hub-sheet-head{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
.dsh-hub-sheet-title{color:var(--dsw-alias-label-primary,#141413);font-size:13px;font-weight:600;margin-right:auto}
.dsh-hub-sheet-kind{align-items:baseline;display:flex;gap:8px;padding:10px 4px 4px}
.dsh-hub-sheet-kind:first-child{padding-top:2px}
.dsh-hub-sheet-kind b{color:var(--dsw-alias-label-primary,#141413);font-size:12.5px;font-weight:600}
.dsh-hub-sheet-kind span{color:var(--dsw-alias-label-caption,#a6a094);font-size:11.5px}
.dsh-hub-sheet-grid{display:grid;gap:3px 10px;grid-template-columns:repeat(auto-fill,minmax(205px,1fr))}
.dsh-hub-tile{align-items:center;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-primary,#141413);cursor:pointer;display:flex;font:inherit;gap:9px;min-height:38px;min-width:0;padding:6px 8px;text-align:left;transition:background .14s ease;width:100%}
.dsh-hub-tile:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dsh-hub-tile:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
.dsh-hub-tile-name{flex:1;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-hub-tile-have{background:#2ea043;border-radius:50%;flex:none;height:6px;width:6px}
.dsh-hub-tile-cnt{color:var(--dsw-alias-label-tertiary,#8f8d84);flex:none;font-size:11px;font-variant-numeric:tabular-nums}
.dsh-hub-empty{color:var(--dsw-alias-label-tertiary,#8f8d84);font-size:12.5px;margin:4px 2px;padding:6px 2px}
.dsh-hub-menu{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);display:flex;flex-direction:column;min-width:144px;padding:4px;position:fixed;z-index:2000}
.dsh-hub-menu-item{align-items:center;background:transparent;border:none;border-radius:6px;color:var(--dsw-alias-label-primary,#141413);cursor:pointer;display:flex;font:inherit;font-size:12.5px;justify-content:space-between;padding:6px 10px;text-align:left;width:100%}
.dsh-hub-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsh-hub-menu-item:disabled{color:var(--dsw-alias-label-caption,#a6a094);cursor:default}
.dsh-hub-skeleton{align-items:center;display:flex;gap:12px;min-height:58px;padding:10px 14px}
.dsh-hub-skeleton+.dsh-hub-skeleton{border-top:0.5px solid var(--dsw-alias-border-l2,#eceadf)}
.dsh-hub-skeleton i{background:var(--dsw-alias-bg-layer-2,#f2f1ea);border-radius:8px;display:block;height:30px;width:30px}
.dsh-hub-skeleton span{background:var(--dsw-alias-bg-layer-2,#f2f1ea);border-radius:5px;display:block;height:11px}
.dsh-hub-skeleton .dsh-hub-skel-name{margin-bottom:6px;width:120px}
.dsh-hub-skeleton .dsh-hub-skel-note{height:9px;width:170px}
@media(max-width:640px){.dsh-hub-row{gap:8px;padding:10px}.dsh-hub-status{display:none}.dsh-hub-search{flex:1;max-width:none;width:auto}.dsh-hub-chevron{display:none}}
.dsh-hub-head{align-items:center;display:flex;flex-wrap:wrap;gap:8px;min-width:0}
.dsh-hub-head .dsh-hub-head-title{flex:0 1 auto;margin:0 auto 0 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-hub-update{align-items:flex-end;display:flex;flex:0 1 auto;flex-direction:column;gap:4px;min-width:0}
.dsh-hub-update-row{align-items:center;display:flex;gap:10px;justify-content:flex-end;min-width:0}
.dsh-hub-update-button{align-items:center;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-tertiary,#8f8d84);cursor:pointer;display:inline-flex;flex:none;height:28px;justify-content:center;padding:0;position:relative;transition:background .15s ease,color .15s ease;width:28px}
.dsh-hub-update-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#141413)}
.dsh-hub-update-button:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-hub-update-button:disabled{cursor:default;opacity:.5}
.dsh-hub-update-icon{display:block}
.dsh-hub-update-button.dsh-hub-update-busy .dsh-hub-update-icon{animation:dsh-hub-update-spin .9s linear infinite}
@keyframes dsh-hub-update-spin{to{transform:rotate(360deg)}}
.dsh-hub-update-dot{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:50%;height:6px;position:absolute;right:2px;top:2px;width:6px}
.dsh-hub-update-state{color:var(--dsw-alias-label-tertiary,#8f8d84);flex:0 1 auto;font-size:11px;line-height:1.45;max-width:320px;min-width:0;text-align:right}
.dsh-hub-update-state.dsh-hub-note-danger{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-hub-update-command{color:var(--dsw-alias-label-tertiary,#8f8d84);display:block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.45;margin:0 0 10px;max-width:320px;overflow-wrap:anywhere;text-align:right;user-select:all}
.dsh-hub-backbar{align-items:center;display:flex;gap:10px;margin-bottom:14px;min-height:32px}
.dsh-hub-back{align-items:center;background:transparent;border:none;border-radius:6px;color:var(--dsw-alias-label-secondary,#5d5c52);cursor:pointer;display:inline-flex;font:inherit;font-size:13px;font-weight:550;gap:2px;padding:5px 8px 5px 2px}
.dsh-hub-back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#141413)}
.dsh-hub-back:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-hub-back svg{display:block}
.dsh-hub-backbar-name{color:var(--dsw-alias-label-tertiary,#8f8d84);font-size:13px;font-weight:600}
.dsh-hub-detail .dsha-page>header .dsh-codex-title{display:none}
.dsh-hub-detail .dsha-page>header{margin-bottom:4px}
`

export function installHubStyles(): void {
  installPluginStyle('hub', CSS)
}
