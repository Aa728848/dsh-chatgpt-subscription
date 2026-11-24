import { installPluginStyle } from '../../common/plugin-style.ts'

const CSS = `
.dsh-sq-panel{display:flex;flex-direction:column;gap:10px;min-width:0;color:var(--dsw-alias-label-primary)}
.dsh-sq-head{align-items:center;display:flex;gap:8px;justify-content:space-between;min-width:0}
.dsh-sq-identity{align-items:center;display:flex;gap:6px;min-width:0;overflow:hidden}
.dsh-sq-provider{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sq-tier{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:999px;color:var(--dsw-alias-label-primary);flex:0 1 auto;font-size:11px;font-weight:500;line-height:1.25;max-width:140px;overflow:hidden;padding:1px 7px;text-overflow:ellipsis;white-space:nowrap}
.dsh-sq-refresh{align-items:center;background:transparent;border:none;border-radius:5px;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;flex:0 0 auto;font:inherit;font-size:11px;gap:4px;line-height:1;padding:3px 5px;transition:background .15s ease,color .15s ease}
.dsh-sq-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary)}
.dsh-sq-refresh:focus-visible{outline:1.5px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
.dsh-sq-refresh:disabled{cursor:default;opacity:.55}
.dsh-sq-refresh-icon{display:block;height:12px;width:12px}
.dsh-sq-refresh[data-loading=true] .dsh-sq-refresh-icon{animation:dsh-sq-spin .85s linear infinite}
@keyframes dsh-sq-spin{to{transform:rotate(360deg)}}

.dsh-sq-bars{display:flex;flex-direction:column;gap:9px;min-width:0}
.dsh-sq-bar-item{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-sq-bar-top{align-items:baseline;display:flex;gap:8px;justify-content:space-between;min-width:0}
.dsh-sq-bar-label{color:var(--dsw-alias-label-primary);flex:1 1 auto;font-size:12px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sq-bar-right{align-items:baseline;display:inline-flex;flex:0 0 auto;gap:6px;white-space:nowrap}
.dsh-sq-bar-reset{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-sq-bar-pct{color:var(--dsw-alias-label-primary);font-size:12px;font-variant-numeric:tabular-nums;font-weight:600}
.dsh-sq-bar-item[data-level=warning] .dsh-sq-bar-pct{color:var(--dsw-alias-label-warning,#d58a24)}
.dsh-sq-bar-item[data-level=danger] .dsh-sq-bar-pct{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-sq-track{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.18));border-radius:999px;height:5px;overflow:hidden;width:100%}
.dsh-sq-fill{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:inherit;display:block;height:100%;max-width:100%;min-width:0;transition:width .25s ease}
.dsh-sq-bar-item[data-level=warning] .dsh-sq-fill{background:var(--dsw-alias-label-warning,#d58a24)}
.dsh-sq-bar-item[data-level=danger] .dsh-sq-fill{background:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-sq-bar-detail{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.3}

.dsh-sq-facts{display:flex;flex-direction:column;gap:5px;margin:0;min-width:0}
.dsh-sq-fact{align-items:baseline;display:flex;font-size:12px;gap:10px;justify-content:space-between;line-height:1.4;min-width:0}
.dsh-sq-fact dt{color:var(--dsw-alias-label-secondary);flex:0 0 auto;margin:0}
.dsh-sq-fact dd{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:500;margin:0;min-width:0;overflow:hidden;text-align:right;text-overflow:ellipsis;white-space:nowrap}
.dsh-sq-fact[data-level=warning] dd{color:var(--dsw-alias-label-warning,#d58a24)}
.dsh-sq-fact[data-level=danger] dd{color:var(--dsw-alias-label-danger,#d94b4b)}

.dsh-sq-note{background:color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 10%,transparent);border-radius:6px;color:var(--dsw-alias-label-danger,#d94b4b);font-size:11px;line-height:1.4;margin:0;padding:5px 8px}

.dsh-sq-reading{align-items:center;color:var(--dsw-alias-label-secondary);display:inline-flex;font-size:11px;font-variant-numeric:tabular-nums;gap:5px;white-space:nowrap}
.dsh-sq-reading[data-level=warning]{color:var(--dsw-alias-label-warning,#d58a24)}
.dsh-sq-reading[data-level=danger]{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-sq-reading-mini{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.22));border-radius:999px;display:inline-block;height:4px;overflow:hidden;width:24px}
.dsh-sq-reading-mini>span{background:currentColor;border-radius:inherit;display:block;height:100%}
`

export function installSessionQuotaStyles(): () => void {
  return installPluginStyle('dsh-session-quota-styles', CSS)
}
