import { installPluginStyle } from '../../common/plugin-style.ts'
const CSS = `
.dshadv-trigger{align-items:center;background:transparent;border:0;border-radius:14px;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;display:inline-flex;font:inherit;font-size:13px;gap:0;height:28px;max-width:200px;padding:0 4px;white-space:nowrap}
.dshadv-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#e8e8e8)}
.dshadv-trigger:disabled{cursor:default;opacity:.5}
.dshadv-trigger-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshadv-trigger[data-enabled=true]{color:var(--dsw-alias-brand-primary,#397ee8)}
.dshadv-effort-trigger{background:transparent;border:0;border-radius:14px;color:var(--dsw-alias-label-secondary,#b8b8b8);cursor:pointer;font:inherit;font-size:13px;height:28px;padding:0 4px;white-space:nowrap}.dshadv-effort-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18));color:var(--dsw-alias-label-primary,#e8e8e8)}.dshadv-effort-trigger:disabled{cursor:default;opacity:.5}.dshadv-effort-popover{padding:8px 6px 6px}.dshadv-popover{background:var(--dsw-alias-bg-overlay,#242422);border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.32);box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom right;z-index:2147482000;animation:dshadv-pop-in 160ms cubic-bezier(.22,.61,.36,1)}@keyframes dshadv-pop-in{from{opacity:0;transform:scale(.96) translateY(4px)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){.dshadv-effort-fill,.dshadv-effort-knob{transition:none}.dshadv-popover{animation:none}}
.dshadv-off-hint{color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:12px;margin:10px 12px;text-align:center}.dshadv-popover-head{align-items:center;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.18));display:flex;flex:none;gap:8px;justify-content:space-between;padding:9px 12px}
.dshadv-popover-title{color:var(--dsw-alias-label-primary,#e8e8e8);font-size:13px;font-weight:500}
.dshadv-popover-foot{border-top:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.18));flex:none;padding:2px 4px 8px}
.dshadv-switch{appearance:none;background:var(--dsw-specific-selector,rgba(127,127,127,.2));border:0;border-radius:9px;cursor:pointer;flex:none;height:18px;padding:2px;width:30px}
.dshadv-switch:before{background:var(--dsw-alias-bg-overlay,#fff);border-radius:50%;content:'';display:block;height:14px;transition:transform .15s;width:14px}
.dshadv-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,#397ee8)}
.dshadv-switch[aria-checked=true]:before{transform:translateX(12px)}
.dshadv-pane{box-sizing:border-box;flex:1 1 auto;min-height:0;overflow:auto;padding:6px}
.dshadv-search{background:var(--dsw-alias-bg-primary,rgba(0,0,0,.25));border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));border-radius:6px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#e8e8e8);font:inherit;margin-bottom:6px;padding:7px 9px;width:100%}
.dshadv-group{color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:11px;font-weight:500;margin:8px 8px 4px}
.dshadv-choice{align-items:center;background:transparent;border:0;border-radius:6px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#e8e8e8);cursor:pointer;display:flex;font:inherit;font-size:13px;gap:8px;justify-content:space-between;line-height:20px;min-height:30px;padding:0 8px;text-align:left;width:100%}
.dshadv-choice:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}
.dshadv-choice:disabled{cursor:default;opacity:.55}
.dshadv-choice[aria-checked=true]{color:var(--dsw-alias-brand-primary,#397ee8)}
.dshadv-effort{margin-top:0;padding:2px 2px 0;--dshadv-effort-tint:0}
.dshadv-effort-tinted{--dshadv-ramp:color-mix(in oklch,var(--dsw-alias-brand-primary,#397ee8),var(--dsw-alias-label-primary,#e8e8e8) calc(var(--dshadv-effort-tint)*1%))}
.dshadv-effort-head{display:flex;align-items:baseline;gap:6px;font-size:11px;margin-bottom:4px}
.dshadv-effort-label{color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dshadv-effort-value{color:var(--dshadv-ramp,var(--dsw-alias-label-primary,#e8e8e8));transition:color 200ms ease}
.dshadv-effort-track{position:relative;height:30px;margin-top:1px;cursor:pointer;touch-action:none}
.dshadv-effort-track:before{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22));border-radius:8px;bottom:50%;content:'';height:26px;margin-bottom:-13px;left:0;position:absolute;right:0}
.dshadv-effort-fill{background:var(--dshadv-ramp,var(--dsw-alias-brand-primary,#397ee8));border-radius:8px 0 0 8px;bottom:50%;height:26px;left:0;margin-bottom:-13px;position:absolute;transition:width 220ms cubic-bezier(.22,.61,.36,1),background 200ms ease;pointer-events:none}
.dshadv-effort-ticks{inset:0;position:absolute;pointer-events:none}
.dshadv-effort-tick{background:color-mix(in srgb,var(--dsw-alias-label-primary,#e8e8e8) 30%,transparent);border-radius:50%;height:4px;margin-top:-2px;position:absolute;top:50%;transform:translateX(-50%);width:4px}
.dshadv-effort-knob{background:#fff;border-radius:5px;box-shadow:0 1px 3px rgba(0,0,0,.45);height:30px;left:0;position:absolute;top:50%;margin-top:-15px;transition:transform 220ms cubic-bezier(.22,.61,.36,1),background-color 200ms ease,box-shadow 200ms ease;width:16px;will-change:transform}
.dshadv-effort[data-dragging] .dshadv-effort-knob{transition:background-color 200ms ease,box-shadow 200ms ease}
.dshadv-effort[data-dragging] .dshadv-effort-fill{transition:background 200ms ease}
.dshadv-effort[data-apex] .dshadv-effort-fill,.dshadv-effort[data-apex] .dshadv-effort-ticks{opacity:0}
.dshadv-effort[data-apex] .dshadv-effort-track:before{background-color:transparent;background-image:radial-gradient(circle at 2px 2px,color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 85%,transparent) 1.6px,transparent 2px),radial-gradient(circle at 2px 2px,color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 45%,transparent) 1.6px,transparent 2px);background-position:0 0,14px 7px;background-size:14px 13px;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 25%,transparent),0 0 10px color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 35%,transparent);animation:dshadv-apex-flow 2.4s linear infinite}
.dshadv-effort[data-apex] .dshadv-effort-knob{background-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 24%,#fff);box-shadow:0 0 12px color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 80%,transparent),0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 38%,transparent)}
.dshadv-effort[data-apex] .dshadv-effort-value{color:color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 65%,var(--dsw-alias-label-primary,#e8e8e8))}
@keyframes dshadv-apex-flow{from{background-position:0 0,14px 7px}to{background-position:14px 0,28px 7px}}
@media(prefers-reduced-motion:reduce){.dshadv-effort[data-apex] .dshadv-effort-track:before{animation:none}}
.dshadv-popover-head{align-items:center;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.18));display:flex;flex:none;gap:8px;justify-content:space-between;padding:9px 12px}
.dshadv-popover-title{color:var(--dsw-alias-label-primary,#e8e8e8);font-size:13px;font-weight:500}
.dshadv-popover-foot{border-top:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.18));flex:none;padding:2px 4px 8px}
.dshadv-switch{appearance:none;background:var(--dsw-specific-selector,rgba(127,127,127,.2));border:0;border-radius:9px;cursor:pointer;flex:none;height:18px;padding:2px;width:30px}
.dshadv-switch:before{background:var(--dsw-alias-bg-overlay,#fff);border-radius:50%;content:'';display:block;height:14px;transition:transform .15s;width:14px}
.dshadv-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,#397ee8)}
.dshadv-switch[aria-checked=true]:before{transform:translateX(12px)}
.dshadv-pane{box-sizing:border-box;flex:1 1 auto;min-height:0;overflow:auto;padding:6px}
.dshadv-search{background:var(--dsw-alias-bg-primary,rgba(0,0,0,.25));border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));border-radius:6px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#e8e8e8);font:inherit;margin-bottom:6px;padding:7px 9px;width:100%}
.dshadv-group{color:var(--dsw-alias-label-tertiary,#9a9a9a);font-size:11px;font-weight:500;margin:8px 8px 4px}
.dshadv-choice{align-items:center;background:transparent;border:0;border-radius:6px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#e8e8e8);cursor:pointer;display:flex;font:inherit;font-size:13px;gap:8px;justify-content:space-between;line-height:20px;min-height:30px;padding:0 8px;text-align:left;width:100%}
.dshadv-choice:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}
.dshadv-choice:disabled{cursor:default;opacity:.55}
.dshadv-choice[aria-checked=true]{color:var(--dsw-alias-brand-primary,#397ee8)}
.dshadv-effort{margin-top:0;padding:2px 2px 0;--dshadv-effort-tint:0}
.dshadv-effort-tinted{--dshadv-ramp:color-mix(in oklch,var(--dsw-alias-brand-primary,#397ee8),var(--dsw-alias-label-primary,#e8e8e8) calc(var(--dshadv-effort-tint)*1%))}
.dshadv-effort-head{display:flex;align-items:baseline;gap:6px;font-size:11px;margin-bottom:4px}
.dshadv-effort-label{color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dshadv-effort-value{color:var(--dshadv-ramp,var(--dsw-alias-label-primary,#e8e8e8));transition:color 200ms ease}
.dshadv-effort-track{position:relative;height:30px;margin-top:1px;cursor:pointer;touch-action:none}
.dshadv-effort-track:before{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22));border-radius:8px;bottom:50%;content:'';height:26px;margin-bottom:-13px;left:0;position:absolute;right:0}
.dshadv-effort-fill{background:var(--dshadv-ramp,var(--dsw-alias-brand-primary,#397ee8));border-radius:8px 0 0 8px;bottom:50%;height:26px;left:0;margin-bottom:-13px;position:absolute;transition:width 220ms cubic-bezier(.22,.61,.36,1),background 200ms ease;pointer-events:none}
.dshadv-effort-ticks{inset:0;position:absolute;pointer-events:none}
.dshadv-effort-tick{background:color-mix(in srgb,var(--dsw-alias-label-primary,#e8e8e8) 30%,transparent);border-radius:50%;height:4px;margin-top:-2px;position:absolute;top:50%;transform:translateX(-50%);width:4px}
.dshadv-effort-knob{background:#fff;border-radius:5px;box-shadow:0 1px 3px rgba(0,0,0,.45);height:30px;left:0;position:absolute;top:50%;margin-top:-15px;transition:transform 220ms cubic-bezier(.22,.61,.36,1),background-color 200ms ease,box-shadow 200ms ease;width:16px;will-change:transform}
.dshadv-effort[data-dragging] .dshadv-effort-knob{transition:background-color 200ms ease,box-shadow 200ms ease}
.dshadv-effort[data-dragging] .dshadv-effort-fill{transition:background 200ms ease}
.dshadv-effort[data-apex] .dshadv-effort-fill,.dshadv-effort[data-apex] .dshadv-effort-ticks{opacity:0}
.dshadv-effort[data-apex] .dshadv-effort-track:before{background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 70%,transparent),color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 30%,transparent),color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 70%,transparent));background-size:220% 100%;animation:dshadv-apex-flow 2.6s linear infinite;box-shadow:0 0 10px color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 45%,transparent)}
.dshadv-effort[data-apex] .dshadv-effort-knob{background-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 24%,#fff);box-shadow:0 0 12px color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 80%,transparent),0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 38%,transparent)}
.dshadv-effort[data-apex] .dshadv-effort-value{color:color-mix(in srgb,var(--dsw-alias-brand-primary,#397ee8) 70%,var(--dsw-alias-label-primary,#e8e8e8))}
@keyframes dshadv-apex-flow{from{background-position:0% 0}to{background-position:220% 0}}
@media(prefers-reduced-motion:reduce){.dshadv-effort[data-apex] .dshadv-effort-track:before{animation:none}}
.dshadv-effort-ends{color:var(--dsw-alias-label-tertiary,#9a9a9a);display:flex;font-size:10px;justify-content:space-between;margin-top:2px}
.dshadv-effort [role=slider][aria-disabled=true]{opacity:.5;pointer-events:none}
`
export function installAdvisorStyles(): () => void { return installPluginStyle('advisor', CSS, 'dsh-advisor-style') }