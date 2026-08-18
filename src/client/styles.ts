const STYLE_ID = '@eddyskywalker/dsh-chatgpt-subscription/main'

const CSS = `
.dsh-codex-page{box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px;max-width:780px;min-width:0;padding:2px 0 30px}
.dsh-codex-page *{box-sizing:border-box}
.dsh-codex-title{font-size:15px;font-weight:650;line-height:1.4;margin:0 0 5px}
.dsh-codex-intro,.dsh-codex-muted{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55;margin:0}
.dsh-codex-group{border-top:1px solid var(--dsw-alias-border-l2);min-width:0}
.dsh-codex-grouphead{align-items:center;display:flex;gap:12px;justify-content:space-between;min-height:48px}
.dsh-codex-grouphead h3{font-size:14px;font-weight:650;margin:0}
.dsh-codex-row{align-items:center;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;gap:20px;justify-content:space-between;min-height:44px;padding:8px 0}
.dsh-codex-label{color:var(--dsw-alias-label-secondary);font-size:13px;flex:0 0 auto}
.dsh-codex-value{font-size:13px;min-width:0;overflow-wrap:anywhere;text-align:right}
.dsh-codex-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding-top:12px}
.dsh-codex-button{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:8px 13px;white-space:nowrap}
.dsh-codex-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-codex-button:focus-visible,.dsh-codex-link:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-codex-button:disabled{cursor:default;opacity:.5}
.dsh-codex-button-primary{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent;color:var(--dsw-alias-button-info-label,#fff)}
.dsh-codex-notice{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;margin:12px 0 0;padding:10px 12px}
.dsh-codex-error,.dsh-codex-warning{font-size:12px;line-height:1.5;margin:8px 0 0}
.dsh-codex-error{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-codex-warning{color:var(--dsw-alias-label-warning,#c77a18)}
.dsh-codex-errorbar{align-items:center;background:color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 9%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-label-danger,#d94b4b) 28%,transparent);border-radius:7px;color:var(--dsw-alias-label-danger,#d94b4b);display:flex;font-size:13px;gap:12px;justify-content:space-between;padding:10px 12px}
.dsh-codex-link{color:var(--dsw-alias-label-link,#3278d4);display:inline-block;font-size:13px;margin-top:8px}
.dsh-codex-models{display:flex;flex-wrap:wrap;gap:6px;padding-top:12px}
.dsh-codex-models code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:5px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:4px 6px}
.dsh-codex-pref-row{align-items:center;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;gap:16px;justify-content:space-between;min-height:58px;padding:10px 0}
.dsh-codex-pref-row strong,.dsh-codex-check strong{display:block;font-size:13px;font-weight:600;line-height:1.35}
.dsh-codex-segments{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;display:flex;flex:none;gap:2px;padding:2px}
.dsh-codex-segments label{cursor:pointer;display:block}
.dsh-codex-segments input{position:absolute;opacity:0;pointer-events:none}
.dsh-codex-segments span{border-radius:6px;color:var(--dsw-alias-label-secondary);display:block;font-size:12px;line-height:1;padding:7px 10px;white-space:nowrap}
.dsh-codex-segments input:checked+span{background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px rgba(0,0,0,.08);color:var(--dsw-alias-label-primary)}
.dsh-codex-segments input:focus-visible+span{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-codex-segments input:disabled+span{cursor:default;opacity:.5}
.dsh-codex-check{align-items:flex-start;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:pointer;display:flex;gap:10px;padding:12px 0}
.dsh-codex-check input{flex:none;margin-top:2px}
.dsh-codex-check small{color:var(--dsw-alias-label-secondary);display:block;font-size:12px;line-height:1.45;margin-top:2px}
.dsh-codex-quota-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;margin-top:12px;padding:12px}
.dsh-codex-quota-title{align-items:center;display:flex;font-size:13px;gap:8px;justify-content:space-between}
.dsh-codex-quota-title span{color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:uppercase}
.dsh-codex-quota-fact{align-items:flex-start;border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;font-size:12px;gap:12px;justify-content:space-between;line-height:1.45;padding:10px 0}
.dsh-codex-quota-fact span{color:var(--dsw-alias-label-secondary);flex:none}
.dsh-codex-quota-fact strong{font-weight:600;min-width:0;overflow-wrap:anywhere;text-align:right}
.dsh-codex-meter-wrap{margin-top:13px}
.dsh-codex-meter-label,.dsh-codex-meter-meta{display:flex;gap:10px;justify-content:space-between}
.dsh-codex-meter-label{font-size:12px;margin-bottom:6px}
.dsh-codex-meter-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45;margin-top:6px}
.dsh-codex-meter{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.15));border-radius:999px;height:7px;overflow:hidden;width:100%}
.dsh-codex-meter>span{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:inherit;display:block;height:100%;max-width:100%;min-width:0;transition:width .25s ease}
.dsh-codex-meter-warning>span{background:var(--dsw-alias-label-warning,#d58a24)}
.dsh-codex-meter-danger>span{background:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-codex-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-tertiary);font-size:12px;margin:12px 0 0;padding:16px;text-align:center}
.dsh-codex-timestamp{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:10px 0 0;text-align:right}
.dsh-codex-skeleton{display:grid;gap:9px;padding-top:10px}
.dsh-codex-skeleton span{animation:dsh-codex-pulse 1.4s ease-in-out infinite;background:var(--dsw-alias-bg-layer-2);border-radius:5px;height:42px}
.dsh-codex-skeleton span:nth-child(2){animation-delay:.12s}.dsh-codex-skeleton span:nth-child(3){animation-delay:.24s}
.dsh-codex-sr{height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;clip:rect(0 0 0 0);white-space:nowrap}
.dsh-codex-composer-quota{align-items:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);display:inline-flex;font-size:11px;gap:6px;height:28px;line-height:1;max-width:160px;padding:0 9px;white-space:nowrap}
.dsh-codex-composer-quota strong{color:var(--dsw-alias-label-primary);font-size:11px;font-weight:650}
.dsh-codex-composer-quota[data-level=warning] strong{color:var(--dsw-alias-label-warning,#d58a24)}
.dsh-codex-composer-quota[data-level=danger] strong{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-codex-image-tool{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;display:flex;flex-direction:column;gap:8px;margin:4px 0 4px 4px;max-width:520px;padding:10px 12px}
.dsh-codex-image-tool-head{align-items:center;display:flex;font-size:13px;gap:8px;min-width:0}
.dsh-codex-image-dot{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:50%;display:inline-block;flex:none;height:8px;width:8px}
.dsh-codex-image-tool[data-state=error] .dsh-codex-image-dot{background:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-codex-image-title{font-weight:600}
.dsh-codex-image-summary{color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-codex-image-grid{display:flex;flex-wrap:wrap;gap:8px}
.dsh-codex-image-preview{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;display:block;max-height:260px;max-width:min(100%,360px);object-fit:contain}
.dsh-codex-image-loading,.dsh-codex-image-failed{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-tertiary);display:inline-flex;font-size:12px;line-height:1.4;padding:18px 20px}
.dsh-codex-image-failed{color:var(--dsw-alias-label-danger,#d94b4b)}
@keyframes dsh-codex-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media(max-width:560px){.dsh-codex-row,.dsh-codex-pref-row,.dsh-codex-quota-fact{align-items:flex-start;flex-direction:column;gap:3px}.dsh-codex-value,.dsh-codex-quota-fact strong{text-align:left}.dsh-codex-actions{justify-content:flex-start}.dsh-codex-grouphead{align-items:flex-start;flex-direction:column;gap:0;padding:12px 0}.dsh-codex-meter-meta{align-items:flex-start;flex-direction:column;gap:2px}.dsh-codex-errorbar{align-items:flex-start;flex-direction:column}.dsh-codex-segments{width:100%}.dsh-codex-segments label{flex:1}.dsh-codex-segments span{text-align:center}.dsh-codex-image-tool{max-width:100%;margin-left:0}}
@media(prefers-reduced-motion:reduce){.dsh-codex-meter>span{transition:none}.dsh-codex-skeleton span{animation:none}}
`

export function installStyles(): () => void {
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => undefined
  const element = document.createElement('style')
  element.dataset.plugin = '@eddyskywalker/dsh-chatgpt-subscription'
  element.dataset.pluginCss = STYLE_ID
  element.textContent = CSS
  document.head.appendChild(element)
  return () => element.remove()
}
