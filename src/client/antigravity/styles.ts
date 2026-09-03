export const STYLE_ID = 'dsh-antigravity-settings-style'

export function installAntigravityStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
.dsha-page{box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:20px;max-width:780px;min-width:0;padding:2px 0 30px}
.dsha-page *{box-sizing:border-box}
.dsha-group{border-top:0.5px solid var(--dsw-alias-border-l2);min-width:0}
.dsha-group:first-of-type{border-top:0}
.dsha-grouphead{align-items:center;display:flex;gap:12px;justify-content:space-between;min-height:48px}
.dsha-grouphead h3{font-size:14px;font-weight:650;margin:0;color:var(--dsw-alias-label-primary)}
.dsha-row{align-items:center;border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;gap:20px;justify-content:space-between;min-height:44px;padding:8px 0}
.dsha-label{color:var(--dsw-alias-label-secondary);font-size:13px;flex:0 0 auto}
.dsha-value{font-size:13px;min-width:0;overflow-wrap:anywhere;text-align:right;color:var(--dsw-alias-label-primary)}
.dsha-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding-top:12px}
.dsha-btn{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:8px 13px;white-space:nowrap}
.dsha-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsha-btn:disabled{cursor:default;opacity:.5}
.dsha-btn-primary{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent;color:var(--dsw-alias-button-info-label,#fff)}
.dsha-btn-primary:hover:not(:disabled){opacity:.9}
.dsha-notice{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;margin:12px 0 0;padding:10px 12px}
.dsha-muted{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55;margin:0}
.dsha-models-hint{padding-top:10px}
.dsha-models{display:flex;flex-wrap:wrap;gap:7px;padding-top:8px}
.dsha-models label{cursor:pointer;display:block;position:relative}
.dsha-models input{position:absolute;opacity:0;pointer-events:none}
.dsha-models span{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);display:block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:5px 8px;transition:all .15s ease}
.dsha-models input:checked+span{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 14%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 55%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary);font-weight:600}
.dsha-models input:disabled+span{cursor:default;opacity:.5}
.dsha-pref-row{align-items:center;border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;gap:16px;justify-content:space-between;min-height:58px;padding:10px 0}
.dsha-pref-row strong{display:block;font-size:13px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary)}
.dsha-select{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 9px;max-width:220px;min-width:160px}
.dsha-context-settings{border-bottom:0.5px solid var(--dsw-alias-border-l2);display:grid;gap:10px;padding:12px 0}
.dsha-context-settings>div>strong{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsha-context-row{align-items:center;display:flex;font-size:12px;gap:14px;justify-content:space-between}
.dsha-capacity-control{align-items:center;display:flex;gap:7px}
.dsha-capacity-control input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;padding:7px 9px;text-align:right;width:90px}
.dsha-capacity-control small{color:var(--dsw-alias-label-tertiary);font-size:11px;width:42px}
.dsha-context-save{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;line-height:1;padding:8px 10px;white-space:nowrap}
.dsha-context-save:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsha-context-save:disabled{cursor:default;opacity:.45}
.dsha-quota-card{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;margin-top:12px;padding:12px}
.dsha-quota-title{align-items:center;display:flex;font-size:13px;gap:8px;justify-content:space-between;color:var(--dsw-alias-label-primary);font-weight:650}
.dsha-quota-title span{color:var(--dsw-alias-label-tertiary);font-size:11px;text-transform:uppercase}
.dsha-meter-wrap{margin-top:13px}
.dsha-meter-label,.dsha-meter-meta{display:flex;gap:10px;justify-content:space-between}
.dsha-meter-label{font-size:12px;margin-bottom:6px;color:var(--dsw-alias-label-primary)}
.dsha-meter-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45;margin-top:6px}
.dsha-meter{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.15));border-radius:999px;corner-shape:round;height:7px;overflow:hidden;width:100%}
.dsha-meter>span{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:inherit;display:block;height:100%;max-width:100%;min-width:0;transition:width .25s ease}
.dsha-meter-green>span{background:var(--dsw-alias-label-success,#10b981)}
.dsha-meter-cyan>span{background:#06b6d4}
.dsha-timestamp{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:10px 0 0;text-align:right}
.dsha-mini-btn{border:0;background:transparent;color:var(--dsw-alias-label-link,#397ee8);font-size:12px;line-height:18px;cursor:pointer;padding:0;margin-left:8px}
.dsha-mini-btn:hover{text-decoration:underline}
.dsha-empty{border:0.5px dashed var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-tertiary);font-size:12px;margin:12px 0 0;padding:16px;text-align:center}
.dsha-error{color:var(--dsw-alias-label-danger,#d94b4b);font-size:12px;margin:8px 0 0}
.dsha-composer-quota{align-items:center;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;corner-shape:round;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;font-size:11px;gap:6px;height:28px;line-height:1;max-width:160px;padding:0 9px;white-space:nowrap;user-select:none;transition:all .15s ease}
.dsha-composer-quota:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dsha-composer-quota strong{color:var(--dsw-alias-label-primary);font-size:11px;font-weight:650}
.dsha-composer-quota[data-level=warning] strong{color:var(--dsw-alias-label-warning,#d58a24)}
.dsha-composer-quota[data-level=danger] strong{color:var(--dsw-alias-label-danger,#d94b4b)}
`
  document.head.append(style)
}
