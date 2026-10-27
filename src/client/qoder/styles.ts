import { installPluginStyle } from '../common/plugin-style.ts'

export const STYLE_ID = 'dsh-qoder-settings-style'

/**
 * Qoder（订阅）卡片独有的样式。
 *
 * 共享样式一律不重复声明：模型清单（.dsh-mcl-*）由 common/model-checklist-styles.ts
 * 负责，账号卡与其配额条（.dsha-account-*）由 common/styles.ts 负责，基础控件
 * （.dsha-page / .dsha-group / .dsha-row / 计量条 .dsha-meter-* 等）由兄弟线路的安装器
 * 负责；本卡直接用它们，不在这里再写一遍。
 *
 * 本文件只声明别处没有的三样：登录流程块（临时内容）、兜底入口行与 PAT 粘贴面板、
 * 等宽文本与额度桶列表。
 *
 * 前缀统一 .dshq-（Qoder），不与任何兄弟线路的选择器相撞。
 */
export function installQoderStyles(): void {
  installPluginStyle('qoder', `
/* 登录流程块是**临时内容**：idle 时整块不渲染，因此它是一条顶部分隔线加间距。 */
.dshq-flow{border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:10px;margin-top:12px;padding-top:12px}
.dshq-flow-url{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.14));border:0.5px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere;padding:8px 10px;user-select:all}
/* 兜底入口行：闲置时只有一行——idle 说明占左侧剩余宽度，PAT 粘贴开关在右侧。
   展开的面板用 flex-basis:100% 折到下一行占满整宽，窄屏回落是自然换行。 */
.dshq-paste{align-items:center;display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.dshq-paste-note{flex:1 1 260px;font-size:12px;min-width:0}
.dshq-paste-body{display:flex;flex:1 1 100%;flex-direction:column;gap:8px}
.dshq-paste-row{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
.dshq-paste-row input{flex:1 1 260px;min-width:200px}
.dshq-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}
.dshq-model-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:5px}
/* 额度桶列表：一桶一行，绝对量（剩余 / 总额 + 单位），不是百分比进度条——
   桶的额度语义是「量」，画成百分比需要先发明一个分母。 */
.dshq-quota-list{display:flex;flex-direction:column;gap:9px;margin-top:12px}
.dshq-quota-row{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
.dshq-quota-name{color:var(--dsw-alias-label-primary);font-size:12px;min-width:104px}
.dshq-quota-value{color:var(--dsw-alias-label-secondary);font-size:12px}
.dshq-quota-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
/* 额度用尽：账号层面的一条事实（上游明说），与三只桶的数字并排给出。 */
.dshq-quota-exhausted{margin-top:11px}
.dshq-quota-exhausted-title{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}
.dshq-quota-exhausted-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;margin-top:4px}
.dshq-quota-exhausted a{color:var(--dsw-alias-label-link,#397ee8);font-size:12px;text-decoration:none}
.dshq-quota-exhausted a:hover{text-decoration:underline}
/* 快照卡里的几行事实：紧凑网格，一格一件事，行高一致。 */
.dshq-fact-grid{display:grid;gap:9px 20px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-top:11px}
.dshq-fact{display:flex;flex-direction:column;gap:3px;min-width:0}
.dshq-fact>span:first-child{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}
.dshq-fact>span:last-child{color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4}

/* 补充说明的折叠区：原句一个不少，只是默认收起。 */
.dshq-details{border-top:0.5px solid var(--dsw-alias-border-l2);padding:10px 0 2px}
.dshq-details>summary{color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1.5;list-style:none;user-select:none}
.dshq-details>summary::-webkit-details-marker{display:none}
.dshq-details[open]>summary{color:var(--dsw-alias-label-primary)}
.dshq-details>p{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;margin:9px 0 0}

.dsha-badge.dshq-adopted{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 16%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-button-info-fill,#397ee8) 45%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}
`, STYLE_ID)
}
