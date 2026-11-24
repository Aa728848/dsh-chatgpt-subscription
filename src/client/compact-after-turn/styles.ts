import { installPluginStyle } from '../common/plugin-style.ts'

const STYLE_ID = 'dsh-compact-after-turn-style'

/* One model-menu row: label, a quiet state hint, and a compact switch that owns
   the whole row's pointer target (same geometry as the host's own menu rows).
   The explanation bubble is transient and never takes the pointer, so it stands
   over every floating card: a theme that redraws the menu as its own popover
   (dsh-claude-style stacks those at 99999) must not cover it. */
/* The switch is the same rounded capsule dsh-claude-style draws for its own
   model-menu rows: corner-shape:round keeps the ends circular where the page
   inherits superellipse corners from <html>, the off track reads the skin's
   chip token when present and the host's selector token otherwise, the thumb
   reads the overlay token, and the on colour reads the brand token. */
const CSS = `
.dshcat-row{align-items:center;border-radius:var(--dsw-radius-md,6px);box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;font-size:13px;gap:8px;line-height:20px;min-height:34px;padding:0 8px;position:relative;width:100%}
.dshcat-label{align-items:center;display:inline-flex;flex:1;gap:4px;min-width:0}
.dshcat-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcat-info{align-items:center;background:transparent;border:0;border-radius:5px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));cursor:help;display:inline-flex;flex:none;height:20px;justify-content:center;padding:0;position:relative;width:20px;z-index:1}
.dshcat-info:hover,.dshcat-info:focus-visible{color:var(--dsw-alias-label-secondary)}
.dshcat-info:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:-2px}
.dshcat-tip{animation:dshcat-tip-in .15s ease-in-out;background:var(--dsw-alias-tooltip-bg,rgba(30,30,30,.92));border-radius:var(--dsw-radius-sm,5px);box-sizing:border-box;color:var(--dsw-alias-tooltip-label,#fff);font-size:13px;line-height:20px;max-width:min(50vw,calc(100vw - 24px));overflow-wrap:break-word;padding:3px 7px;pointer-events:none;position:fixed;transform:translate(-50%,-100%);white-space:pre-line;width:max-content;z-index:2147482000}
@keyframes dshcat-tip-in{from{opacity:0}}
.dshcat-state{color:var(--dsw-alias-label-tertiary);flex:none;font-size:12px}
.dshcat-row[data-phase=compacting] .dshcat-state{color:var(--dsw-alias-label-warning,#d58a24)}
.dshcat-switch{appearance:none;background:var(--dsh-claude-chip,var(--dsw-specific-selector,rgba(127,127,127,.18)));border:0;border-radius:9px;box-sizing:border-box;corner-shape:round;cursor:pointer;flex:none;height:18px;margin:0;padding:2px;position:static;transition:background-color .15s ease;width:30px}
.dshcat-switch::before{background:var(--dsw-alias-bg-overlay,#fff);border-radius:50%;box-shadow:0 1px 2px rgba(20,20,19,.18);content:"";corner-shape:round;display:block;height:14px;transition:transform .15s ease;width:14px}
.dshcat-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,#397ee8)}
.dshcat-switch[aria-checked=true]::before{transform:translateX(12px)}
.dshcat-switch:disabled{cursor:default;opacity:.5}
.dshcat-switch::after{border-radius:var(--dsw-radius-md,6px);content:"";inset:0;position:absolute}
.dshcat-switch:focus-visible{outline:none}
.dshcat-row:has(.dshcat-switch:focus-visible){background:var(--dsw-alias-interactive-bg-hover)}
@media (hover:hover){.dshcat-row:has(.dshcat-switch:not(:disabled)):hover{background:var(--dsw-alias-interactive-bg-hover)}}
@media (prefers-reduced-motion:reduce){.dshcat-switch,.dshcat-switch::before{transition:none}.dshcat-tip{animation:none}}
`

export function installCompactAfterTurnStyles(): () => void {
  return installPluginStyle('compact-after-turn', CSS, STYLE_ID)
}
