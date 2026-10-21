/**
 * Styles for the subscription hub: the overview's provider cards, the detail
 * page's back bar, and the provider switch. Installed through the shared
 * installer so the module system never claims the sheet (see
 * common/plugin-style.ts). Colors ride DSH theme tokens, so dark mode needs
 * no branch of its own.
 */
import { installPluginStyle } from '../common/plugin-style.ts'

const CSS = `
.dsh-hub-overview{display:flex;flex-direction:column;min-width:0}
.dsh-hub-hint{color:var(--dsw-alias-label-secondary,#5d5c52);font-size:13px;line-height:1.55;margin:0 0 14px}
.dsh-hub-cards{border-top:0.5px solid var(--dsw-alias-border-l2,#eceadf)}
.dsh-hub-card{align-items:center;background:transparent;border:none;border-bottom:0.5px solid var(--dsw-alias-border-l2,#eceadf);color:var(--dsw-alias-label-primary,#141413);cursor:pointer;display:flex;gap:14px;font:inherit;min-height:68px;padding:12px 6px;text-align:left;width:100%}
.dsh-hub-card:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dsh-hub-card:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:-2px}
.dsh-hub-card[data-enabled=false] .dsh-hub-card-name,.dsh-hub-card[data-enabled=false] .dsh-hub-card-note{opacity:.55}
.dsh-hub-card-copy{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0}
.dsh-hub-card-name{font-size:14px;font-weight:600;line-height:1.3}
.dsh-hub-card-note{color:var(--dsw-alias-label-tertiary,#8f8d84);font-size:12px;line-height:1.4}
.dsh-hub-card-note.dsh-hub-note-danger{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-hub-card-side{align-items:center;display:flex;flex:none;gap:10px}
.dsh-hub-chevron{color:var(--dsw-alias-label-caption,#a6a094);display:inline-flex;flex:none}
.dsh-hub-brand-tile{align-items:center;background:color-mix(in srgb,var(--dsh-hub-brand,#888) 10%,transparent);border-radius:10px;display:inline-flex;flex:none;justify-content:center;overflow:hidden}
.dsh-hub-brand-tile>svg{display:block}
.dsh-hub-brand-image{display:block;height:100%;width:100%}
.dsh-hub-brand-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:15px;font-weight:700;line-height:1}
.dsh-hub-switch{background:var(--dsw-alias-bg-layer-2,#f2f1ea);border:0.5px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:999px;box-sizing:border-box;cursor:pointer;flex:none;height:24px;padding:2px;position:relative;transition:background .15s ease,border-color .15s ease;width:44px}
.dsh-hub-switch::after{background:var(--dsw-alias-bg-layer-1,#fff);border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.28);content:"";display:block;height:19px;transition:transform .15s ease;width:19px}
.dsh-hub-switch[aria-checked=true]{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent}
.dsh-hub-switch[aria-checked=true]::after{transform:translateX(20px)}
.dsh-hub-switch:disabled{cursor:default;opacity:.5}
.dsh-hub-switch:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-hub-skeleton{border-bottom:0.5px solid var(--dsw-alias-border-l2,#eceadf);display:flex;gap:14px;min-height:68px;padding:12px 6px;align-items:center}
.dsh-hub-skeleton i{background:var(--dsw-alias-bg-layer-2,#f2f1ea);border-radius:10px;display:block;height:40px;width:40px}
.dsh-hub-skeleton span{background:var(--dsw-alias-bg-layer-2,#f2f1ea);border-radius:5px;display:block;height:12px}
.dsh-hub-skeleton .dsh-hub-skel-name{width:120px;margin-bottom:6px}
.dsh-hub-skeleton .dsh-hub-skel-note{width:180px;height:10px}
/* The section header carries the title and the one page-level control: title
   left, control right, nothing else. A space-between row gives its LAST item the
   row's right edge, and every line that can appear lives to the left of the icon,
   so the icon owns that edge in all four states. */
.dsh-hub-head{align-items:center;display:flex;gap:12px;justify-content:space-between;min-width:0}
/* On a narrow window the title gives way (ellipsis) rather than the icon, which
   the control keeps at a fixed size. */
.dsh-hub-head .dsh-hub-head-title{flex:0 1 auto;margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Inside the control the status text shrinks and the icon does not, so a long
   error or a version sentence grows leftwards instead of moving the icon. */
.dsh-hub-update{align-items:flex-end;display:flex;flex:0 1 auto;flex-direction:column;gap:4px;min-width:0}
.dsh-hub-update-row{align-items:center;display:flex;gap:10px;justify-content:flex-end;min-width:0}
/* A 28px icon button: no frame, no label. Quiet until hovered, which is why the
   section header can carry it without turning into a toolbar. */
.dsh-hub-update-button{align-items:center;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-tertiary,#8f8d84);cursor:pointer;display:inline-flex;flex:none;height:28px;justify-content:center;padding:0;position:relative;transition:background .15s ease,color .15s ease;width:28px}
.dsh-hub-update-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#141413)}
.dsh-hub-update-button:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-hub-update-button:disabled{cursor:default;opacity:.5}
.dsh-hub-update-icon{display:block}
/* A check or an install is a wait with no progress to report, so the ring turns
   instead of the control growing a spinner and changing size. */
.dsh-hub-update-button.dsh-hub-update-busy .dsh-hub-update-icon{animation:dsh-hub-update-spin .9s linear infinite}
@keyframes dsh-hub-update-spin{to{transform:rotate(360deg)}}
/* One accent dot instead of a wider button: the offer stays visible and the icon
   keeps both its size and its position. */
.dsh-hub-update-dot{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:50%;height:6px;position:absolute;right:2px;top:2px;width:6px}
/* 11px, like the cards' annotation line, so the control reads as a note about
   the page rather than a second call to action. Right-aligned, because a wrapped
   line then stays against the icon it belongs to; shrinkable, so its length can
   never move that icon. */
.dsh-hub-update-state{color:var(--dsw-alias-label-tertiary,#8f8d84);flex:0 1 auto;font-size:11px;line-height:1.45;max-width:320px;min-width:0;text-align:right}
.dsh-hub-update-state.dsh-hub-note-danger{color:var(--dsw-alias-label-danger,#d94b4b)}
/* The escape hatch when the icon cannot act. It sits on its own line under the
   header row, inside the control, so it never widens the row it belongs to.
   user-select:all makes one click take the whole command, which is the only
   clipboard the page needs. */
.dsh-hub-update-command{color:var(--dsw-alias-label-tertiary,#8f8d84);display:block;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.45;margin:0 0 10px;max-width:320px;overflow-wrap:anywhere;text-align:right;user-select:all}
.dsh-hub-backbar{align-items:center;display:flex;gap:10px;margin-bottom:14px;min-height:32px}
.dsh-hub-back{align-items:center;background:transparent;border:none;border-radius:6px;color:var(--dsw-alias-label-secondary,#5d5c52);cursor:pointer;display:inline-flex;font:inherit;font-size:13px;font-weight:550;gap:2px;padding:5px 8px 5px 2px}
.dsh-hub-back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#141413)}
.dsh-hub-back:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-hub-back svg{display:block}
.dsh-hub-backbar-name{color:var(--dsw-alias-label-tertiary,#8f8d84);font-size:13px;font-weight:600}
/* In the hub's detail page the back bar already names the provider, so the
   section's own page-level title would read as a duplicate. The intro line
   under it stays — it describes the line, not the location. Only ChatGPT's
   section renders such a header; the other seven begin with their content. */
.dsh-hub-detail .dsha-page>header .dsh-codex-title{display:none}
.dsh-hub-detail .dsha-page>header{margin-bottom:4px}
`

export function installHubStyles(): void {
  installPluginStyle('hub', CSS)
}
