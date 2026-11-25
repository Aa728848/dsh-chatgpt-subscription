import { installPluginStyle } from '../../common/plugin-style.ts'
import { installKimiCodeStyles } from '../kimi-code/styles.ts'

export const STYLE_ID = 'dsh-opencode-go-settings-style'

/** Only OpenCode-specific rules; shared controls and the Kimi quota shell are installed from their owner. */
export function installOpenCodeGoStyles(): void {
  installKimiCodeStyles()
  installPluginStyle('opencode-go', `
.dshoc-page .dsha-btn{border-radius:14px}
.dshoc-quota .dsha-kq-seg--cyan{background:#06b6d4}
.dshoc-art{color:var(--dsw-alias-label-primary);height:64px;overflow:visible;pointer-events:none;position:absolute;right:6px;top:50%;transform:translateY(-50%);width:140px}
.dshoc-art text{fill:currentColor;opacity:0;transform:scale(.8) translateY(16px);transform-box:fill-box;transform-origin:bottom;transition:opacity .2s ease-in-out,transform .2s ease-in-out}
.dshoc-account:hover .dshoc-art text,.dshoc-quota:focus-within .dshoc-art text{opacity:1;transform:scale(1) translateY(0);transition:opacity .6s ease-in-out,transform .6s ease-in-out;transition-delay:calc(var(--i,0) * 80ms)}
.dshoc-quota-empty{margin:12px 0 0}
.dshoc-apikey{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.dshoc-apikey-row{align-items:center;display:flex;gap:8px}
.dshoc-apikey-row input.dsha-select{flex:1 1 auto;font-size:13px;max-width:none;min-width:0;padding:8px 12px;width:auto}
@media(prefers-reduced-motion:reduce){.dshoc-art text{opacity:1;transform:none;transition:none}}
`, STYLE_ID)
}
