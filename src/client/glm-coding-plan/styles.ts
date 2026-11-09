import { installPluginStyle } from '../common/plugin-style.ts'

export const STYLE_ID = 'dsh-glm-coding-plan-settings-style'

/**
 * GLM（ZCode 账号）卡片独有的样式。
 *
 * 共享样式一律不重复声明：模型清单（.dsh-mcl-*）由 common/model-checklist-styles.ts
 * 负责，账号卡与配额条（.dsha-account-*）由 common/styles.ts 负责，基础控件
 * （.dsha-page / .dsha-group / .dsha-row / 胶囊等）由兄弟线路的安装器负责。
 * 本文件只声明没有兄弟线路共用过的东西：登录流程块、兜底入口行与手工粘贴面板、
 * 等宽文本、模型行右侧的窗口数字，以及「导入的登录态」徽标。
 *
 * 两区登录入口复用的 .dsha-account-add-actions 是跨线路共享的声明，现在随本文件
 * 一起安装；Claude / Step Code / Qoder / Cline Pass / OpenDesign / Codex 卡片都直接
 * 用它而不在自己文件里重复声明，本卡沿用同一做法。
 */
export function installGlmCodingPlanStyles(): void {
  installPluginStyle('glm-coding-plan', `
/* 登录流程块是**临时内容**：idle 时整块不渲染，因此它是一条顶部分隔线加间距，
   不再有底边——下面紧接着就是兜底入口行，两条线会把中间那一段夹成夹心。 */
.dshglm-flow{border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:10px;margin-top:12px;padding-top:12px}
.dshglm-flow-url{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.14));border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere;padding:8px 10px;user-select:all}
/* 兜底入口行：闲置时只有一行——idle 说明占左侧剩余宽度，手工粘贴开关在右侧。
   展开的面板用 flex-basis:100% 折到下一行占满整宽，所以窄屏回落是自然换行，
   不需要额外的媒体查询（写法与共享 .dsha-account-add-actions 同一套节奏）。 */
.dshglm-paste{align-items:center;display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.dshglm-paste-note{flex:1 1 260px;font-size:12px;min-width:0}
.dshglm-paste-body{display:flex;flex:1 1 100%;flex-direction:column;gap:8px}
.dshglm-paste-row{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
.dshglm-paste-row input{flex:1 1 260px;min-width:200px}
.dshglm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}
.dshglm-model-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:5px}
.dsha-badge.glm-adopted{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 16%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 45%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}

/* 跨线路共享的登录入口按钮行：两区登录入口把多个按钮排进同一行，行本身只负责
   换行与间距。按钮的主次由各自的 class 决定 —— 主按钮带 .dsha-btn-primary，取信息
   色填充；次要入口（设备码登录、导入本地登录）保持中性外观，这样一行里才读得出
   「主入口 + 另外两种进入方式」。这里原先统一涂成信息色，是为了绕开
   .dsha-btn:hover 盖掉主按钮填充的问题（见 antigravity / kimi-code 两张表里的
   :not(.dsha-btn-primary)）；通用 hover 修好后它只剩副作用：把 .dsha-btn 的次要
   按钮也画成主按钮，故删除。 */
.dsha-account-add-actions{display:flex;flex-wrap:wrap;gap:8px}
`, STYLE_ID)
}
