import { installPluginStyle } from '../common/plugin-style.ts'

export const STYLE_ID = 'dsh-kimi-code-settings-style'

/**
 * Node the base control styles come from.
 *
 * The Kimi Code card renders the same controls as the sibling routes, so it
 * reuses one extracted stylesheet verbatim rather than re-declaring a parallel
 * design system that would drift from it.
 */
const BASE = `
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
.dsha-context-reset{color:var(--dsw-alias-label-secondary)}
.dsha-context-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
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

.dsha-device-box{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;display:flex;flex-direction:column;gap:10px;margin-top:12px;padding:12px}
.dsha-code-row{align-items:center;display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between}
.dsha-code{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.14));border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:16px;font-weight:650;letter-spacing:.14em;padding:8px 12px}
.dsha-link{color:var(--dsw-alias-label-link,#397ee8);font-size:12px;overflow-wrap:anywhere;text-decoration:none}
.dsha-link:hover{text-decoration:underline}
.dsha-model-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:5px}
.dsha-badge{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.14));border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-tertiary);font-size:10px;padding:2px 6px}
.dsha-cap-table{border-bottom:0.5px solid var(--dsw-alias-border-l2);padding:12px 0}
.dsha-cap-table table{border-collapse:collapse;font-size:11px;width:100%}
.dsha-cap-table th{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500;padding:0 10px 6px 0;text-align:left;white-space:nowrap}
.dsha-cap-table th:last-child,.dsha-cap-table td:last-child{padding-right:0}
.dsha-cap-table td{border-top:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);padding:8px 10px 8px 0;vertical-align:top}
.dsha-cap-table td:first-child{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}
.dsha-cap-table td:nth-child(2),.dsha-cap-table td:nth-child(3){white-space:nowrap}
.dsha-cap-on{color:var(--dsw-alias-label-primary);font-weight:500}
.dsha-cap-off{color:var(--dsw-alias-label-tertiary)}
.dsha-cap-notes{line-height:1.5;min-width:200px}
.dsha-cap-cost{color:var(--dsw-alias-label-primary);display:block;font-weight:500;margin-bottom:3px}
.dsha-cap-footnote{font-size:11px;line-height:1.55;margin:8px 0 0}
.dsha-warn{border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;line-height:1.55;margin:0 0 10px;padding:8px 10px}

/* ---------- Kimi Code 账号卡片里的额度区（KimiQuotaCard） ----------
   档位名用 Georgia 字标，右侧压一条五线谱；音符按档位换插图，悬停时逐笔浮入。
   总使用量是 Kimi 池与 Code 池的堆叠条，5 小时与 7 天各一条单行进度。 */
/* ---------- 卡面：圆角、细边与顶部一道极淡的高光 ----------
   形状与层次照搬 index.html 里那张卡；颜色仍走 dsw 令牌，浅色主题下同一套规则也成立。 */
.dsha-account-card.dsha-account-card--kimi{border-radius:14px;border-width:1px;background-image:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent),transparent 46%);transition:border-color .3s ease,box-shadow .3s ease}
.dsha-account-card.dsha-account-card--kimi:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,var(--dsw-alias-border-l2));box-shadow:0 8px 24px rgba(0,0,0,.16)}

.dsha-kq{--kq-fg:var(--dsw-alias-label-primary);--kq-fg-2:var(--dsw-alias-label-secondary);--kq-fg-3:var(--dsw-alias-label-tertiary);--kq-line:var(--dsw-alias-border-l2);--kq-track:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);--kq-rest:var(--dsw-alias-label-primary,#1a1a19);--kq-code:var(--dsw-alias-button-info-fill,#397ee8);--kq-tip-bg:var(--dsw-alias-label-primary,#2f2f2d);color:var(--kq-fg);display:flex;flex-direction:column;min-width:0}
.dsha-kq-head{align-items:center;display:flex;gap:6px}
.dsha-kq-tier{font-family:Georgia,"Times New Roman",serif;font-size:24px;font-weight:400;letter-spacing:-1.4px;line-height:1.4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-kq-staff{display:flex;flex:1;flex-direction:column;gap:4px;height:21px;margin-right:-6px;min-width:48px;position:relative}
.dsha-kq-staff>i{background:var(--kq-line);display:block;height:1px;width:100%}
.dsha-kq-art{overflow:visible;position:absolute;right:6px;top:50%;transform:translateY(-50%)}
.dsha-kq-art path{opacity:0;transform:scale(.8) translateY(16px);transform-origin:bottom;transition:opacity .2s ease-in-out,transform .2s ease-in-out}
.dsha-account-card:hover .dsha-kq-art path,.dsha-kq:focus-within .dsha-kq-art path{opacity:1;transform:scale(1) translateY(0);transition:opacity .6s ease-in-out,transform .6s ease-in-out;transition-delay:calc(var(--i,0) * 80ms)}
.dsha-kq-total{margin-top:14px}
.dsha-kq-row{align-items:baseline;column-gap:10px;display:flex;flex-wrap:wrap;min-width:0;row-gap:2px}
.dsha-kq-label{color:var(--kq-fg);font-size:14px;white-space:nowrap}
.dsha-kq-value{color:var(--kq-fg);font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsha-kq-barwrap{margin-top:11px;position:relative}
.dsha-kq-meter{background:var(--kq-track);border-radius:999px;display:flex;gap:2px;height:8px;overflow:hidden}
.dsha-kq-meter--total{border-radius:4px;height:12px}
.dsha-kq-meter--total .dsha-kq-seg{border-radius:2px}
.dsha-kq-seg{border-radius:999px;display:block;height:100%;transition:width .9s cubic-bezier(.22,.61,.36,1)}
.dsha-kq-seg--recent{background:var(--kq-code)}
.dsha-kq-seg--rest{background:var(--kq-rest)}
.dsha-kq-tip{background:var(--kq-tip-bg);border-radius:10px;bottom:calc(100% + 10px);color:var(--dsw-alias-bg-base,#fff);font-size:13px;line-height:1;left:var(--kq-tip-x,50%);opacity:0;padding:9px 14px;pointer-events:none;position:absolute;transform:translate(calc(-50% + var(--kq-tip-shift,0px)),4px);transition:opacity .16s ease-out,transform .16s ease-out;white-space:nowrap}
/* 箭头不跟气泡的位移走：气泡被 --kq-tip-shift 收回卡片内时，箭头按
   --kq-tip-arrow 单独挪回「已用段末端」在气泡里的位置，所以它指的一直是那个数字。 */
.dsha-kq-tip::after{border:6px solid transparent;border-top-color:var(--kq-tip-bg);content:"";left:var(--kq-tip-arrow,50%);margin-left:-6px;position:absolute;top:100%}
.dsha-kq-barwrap:hover .dsha-kq-tip{opacity:1;transform:translate(calc(-50% + var(--kq-tip-shift,0px)),0)}
.dsha-kq-legend{align-items:center;color:var(--kq-fg-2);column-gap:16px;display:flex;flex-wrap:wrap;font-size:13px;margin-top:11px;row-gap:6px}
.dsha-kq-legend-item{align-items:center;display:inline-flex;gap:6px;white-space:nowrap}
.dsha-kq-legend-note{color:var(--kq-fg-3);white-space:nowrap}
.dsha-kq-dot{border-radius:2px;display:block;height:8px;width:8px}
.dsha-kq-dot--recent{background:var(--kq-code)}
.dsha-kq-dot--rest{background:var(--kq-rest)}
.dsha-kq-reset{color:var(--kq-fg-3);font-size:12px;font-variant-numeric:tabular-nums;margin-left:auto;white-space:nowrap}
.dsha-kq-sep{border:0;border-top:0.5px solid var(--kq-line);height:0;margin:16px 0}
.dsha-kq-window+.dsha-kq-window{margin-top:16px}
.dsha-kq-window-label{color:var(--kq-fg);font-size:14px}
.dsha-kq-window-pct{color:var(--kq-fg);font-size:14px;font-variant-numeric:tabular-nums}
.dsha-kq-window .dsha-kq-meter{margin-top:8px}
.dsha-kq-foot{align-items:baseline;color:var(--kq-fg-3);column-gap:12px;display:flex;flex-wrap:wrap;font-size:11px;font-variant-numeric:tabular-nums;justify-content:space-between;margin-top:14px;row-gap:4px}
.dsha-kq-foot-left{align-items:baseline;column-gap:10px;display:inline-flex;flex-wrap:wrap;min-width:0;row-gap:2px}
.dsha-kq-foot-left>span{white-space:nowrap}
.dsha-kq-expires{text-align:right;white-space:nowrap}
.dsha-kq-blank{margin:12px 0 0}
`

/** Kimi-specific rules layered on top of the shared control styles. */
export function installKimiCodeStyles(): void {
  installPluginStyle('kimi-code', BASE, STYLE_ID)
}
