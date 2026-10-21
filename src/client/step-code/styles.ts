import { installPluginStyle } from '../common/plugin-style.ts'

export const STYLE_ID = 'dsh-step-code-settings-style'

/**
 * Step Code（Step Plan 订阅）卡片独有的样式。
 *
 * 共享样式一律不重复声明：模型清单（.dsh-mcl-*）由 common/model-checklist-styles.ts
 * 负责，账号卡与其配额条（.dsha-account-*）由 common/styles.ts 负责，基础控件
 * （.dsha-page / .dsha-group / .dsha-row / 计量条 .dsha-meter-* 等）由兄弟线路的安装器
 * 负责；本卡直接用它们，不在这里再写一遍。.dsha-account-add-actions 同样沿用
 * glm-coding-plan/styles.ts 随安装器带出的那份共享声明。
 *
 * 本文件只声明三样别处没有的东西：
 *
 *   1. 本线路自己的登录相关块：登录流程块（临时内容）、兜底入口行与手工粘贴面板、
 *      等宽文本、模型行右侧的窗口数字；
 *   2. **线路级额度**的形状：老式窗口与 Credit 桶各有各的行与条，以及快照卡里那几行
 *      事实用的紧凑网格（.dshsc-fact-grid）。账号卡里的 .dsha-account-quota-* 是共享
 *      组件的，不在这里重复；
 *   3. 两处版面纪律所需的类：**补充说明的折叠区**（.dshsc-details）与**额度凭据的输入
 *      网格**（.dshsc-cred-grid）。网格窄屏回落成单列，媒体查询照抄 common/styles.ts
 *      里 max-width:560px 的现成写法。
 *
 * 折叠区不删信息：每一句说明仍然在 DOM 与 textContent 里，只是默认不占版面；正文因此
 * 只留「标题 → 一句话 → 控件 → 折叠的补充说明」。
 *
 * 前缀统一 .dshsc-（Step Code），不与任何兄弟线路的选择器相撞。
 */
export function installStepCodeStyles(): void {
  installPluginStyle('step-code', `
/* 登录流程块是**临时内容**：idle 时整块不渲染，因此它是一条顶部分隔线加间距，
   不再有底边——下面紧接着就是兜底入口行，两条线会把中间那一段夹成夹心。 */
.dshsc-flow{border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:10px;margin-top:12px;padding-top:12px}
.dshsc-flow-url{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.14));border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere;padding:8px 10px;user-select:all}
/* 兜底入口行：闲置时只有一行——idle 说明占左侧剩余宽度，手工粘贴开关在右侧。
   展开的面板用 flex-basis:100% 折到下一行占满整宽，所以窄屏回落是自然换行，
   不需要额外的媒体查询（与 GLM 卡同一套写法）。 */
.dshsc-paste{align-items:center;display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.dshsc-paste-note{flex:1 1 260px;font-size:12px;min-width:0}
.dshsc-paste-body{display:flex;flex:1 1 100%;flex-direction:column;gap:8px}
.dshsc-paste-row{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
.dshsc-paste-row input{flex:1 1 260px;min-width:200px}
.dshsc-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}
.dshsc-model-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:5px}
.dshsc-quota-list{display:flex;flex-direction:column;gap:9px;margin-top:12px}
.dshsc-quota-row{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
.dshsc-quota-name{color:var(--dsw-alias-label-primary);font-size:12px;min-width:104px}
.dshsc-quota-track{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.15));border-radius:999px;height:7px;overflow:hidden;width:100%}
.dshsc-quota-track>span{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:inherit;display:block;height:100%;max-width:100%;min-width:0;transition:width .25s ease}
.dshsc-quota-row[data-level='warning'] .dshsc-quota-track>span{background:var(--dsw-alias-label-warning,#f59e0b)}
.dshsc-quota-row[data-level='danger'] .dshsc-quota-track>span{background:var(--dsw-alias-label-danger,#ef4444)}
.dshsc-quota-value{color:var(--dsw-alias-label-secondary);font-size:12px}
.dshsc-quota-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshsc-bucket{border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-wrap:wrap;gap:8px;padding-top:9px}
/* 快照卡里的几行事实：紧凑网格，一格一件事，行高一致。
   auto-fit + minmax 是为了窄屏自动折列，而不是让一行一个标签占满整宽。 */
.dshsc-fact-grid{display:grid;gap:9px 20px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-top:11px}
.dshsc-fact{display:flex;flex-direction:column;gap:3px;min-width:0}
.dshsc-fact>span:first-child{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}
.dshsc-fact>span:last-child{color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4}

/* 补充说明的折叠区：原句一个不少，只是默认收起。 */
.dshsc-details{border-top:0.5px solid var(--dsw-alias-border-l2);padding:10px 0 2px}
.dshsc-details>summary{color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1.5;list-style:none;user-select:none}
.dshsc-details>summary::-webkit-details-marker{display:none}
.dshsc-details[open]>summary{color:var(--dsw-alias-label-primary)}
.dshsc-details>p{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;margin:9px 0 0}

/* 额度凭据：两个获取方式各一个子块，输入行是网格而不是可换行的 flex 行——
   flex-wrap 会让按钮在窄屏单独掉到下一行且与输入框错位，网格保证等高、同一基线。 */
.dshsc-cred-block{border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:8px;padding:13px 0}
.dshsc-cred-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.35}
.dshsc-cred-grid{align-items:center;display:grid;gap:8px;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto}
.dshsc-cred-grid-narrow{grid-template-columns:minmax(0,1fr) auto}
.dshsc-cred-grid>input{max-width:none;min-width:0;width:100%}
/* 窄屏回落：写法与 common/styles.ts:34 里的 max-width:560px 媒体查询一致。
   凭据网格折成单列；兜底入口行不需要媒体查询——它本来就是可换行的 flex 行。 */
@media(max-width:560px){.dshsc-cred-grid,.dshsc-cred-grid-narrow{grid-template-columns:minmax(0,1fr)}}

.dsha-badge.dshsc-adopted{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 16%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 45%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
`, STYLE_ID)
}
