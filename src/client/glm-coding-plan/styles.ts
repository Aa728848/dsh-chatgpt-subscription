import { installPluginStyle } from '../common/plugin-style.ts'

export const STYLE_ID = 'dsh-glm-coding-plan-settings-style'

/**
 * GLM（ZCode 账号）卡片独有的样式。
 *
 * 共享样式一律不重复声明：模型清单（.dsh-mcl-*）由 common/model-checklist-styles.ts
 * 负责，账号卡与配额条（.dsha-account-*）由 common/styles.ts 负责，基础控件
 * （.dsha-page / .dsha-group / .dsha-row / 胶囊等）由兄弟线路的安装器负责。
 * 本文件只声明没有兄弟线路共用过的东西：登录流程块、手工粘贴行、等宽文本、
 * 模型行右侧的窗口数字，以及「导入的登录态」徽标。
 *
 * 两区登录入口复用的 .dsha-account-add-actions 由 workbuddy/styles.ts 声明；
 * Claude 卡片同样直接用它而不在自己文件里重复声明，本卡沿用同一做法。
 */
export function installGlmCodingPlanStyles(): void {
  installPluginStyle('glm-coding-plan', `
.dshglm-flow{border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:10px;padding:12px 0}
.dshglm-flow-url{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.14));border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere;padding:8px 10px;user-select:all}
.dshglm-paste{align-items:flex-start;display:flex;flex-direction:column;gap:8px}
.dshglm-paste-row{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
.dshglm-paste-row input{flex:1 1 260px;min-width:200px}
.dshglm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}
.dshglm-model-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:5px}
.dsha-badge.glm-adopted{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 16%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 45%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
`, STYLE_ID)
}
