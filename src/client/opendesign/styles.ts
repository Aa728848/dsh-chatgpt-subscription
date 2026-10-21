import { installPluginStyle } from '../common/plugin-style.ts'

/**
 * OpenDesign's own prefixed classes only: the key form and the advanced
 * controls, which the shared `.dsha-*` vocabulary has no expression for.
 * Everything else on the tab reuses the shared card.
 *
 * `.dshod-input` mirrors the input styling another line declares under an
 * unprefixed name on purpose: that class is that line's own, and a prefix of
 * ours keeps this card's look from drifting with someone else's sheet.
 */
export function installOpenDesignStyles(): void {
  installPluginStyle('opendesign', `
.dshod-input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 10px;box-sizing:border-box}
.dshod-input:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
.dshod-input:disabled{opacity:.5}
.dshod-keyform{display:flex;flex-direction:column;gap:8px;align-items:stretch;margin-top:8px}
.dshod-keyrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.dshod-link{color:var(--dsw-alias-button-info-fill,#397ee8);font-size:12px;text-decoration:none}
.dshod-link:hover{text-decoration:underline}
.dshod-details{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshod-details>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none}
.dshod-details ul{margin:6px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px}
.dshod-flow{border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:8px;margin-top:10px;padding-top:10px}
.dshod-login-row{align-items:center;display:flex;gap:12px;flex-wrap:wrap;margin:4px 0}
.dshod-login-code{border:0.5px solid var(--dsw-alias-brand-primary);border-radius:8px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;font-weight:700;letter-spacing:.18em;padding:6px 14px}
.dshod-paste{align-items:center;display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;margin-top:8px}
.dshod-paste-note{font-size:12px}
.dshod-warning{color:var(--dsw-alias-label-warning,#d9913b);font-size:12px}
.dshod-adv-control{width:240px;max-width:100%;flex:none}
.dshod-adv-control.dsha-select{max-width:240px;min-width:240px;width:240px}
.dshod-adv-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.dshod-adv-num{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-align:right;font-variant-numeric:tabular-nums}
@media(max-width:720px){
  .dshod-adv-control,.dshod-adv-control.dsha-select{width:100%;max-width:none;min-width:0}
}
`)
}
