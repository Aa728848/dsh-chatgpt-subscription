/**
 * 进展更新设置卡片的样式。
 *
 * ## 来源（方案 B：逐字抄进本插件，不做跨包同步机制）
 *
 * 结构与取值抄自同目录之外的订阅服务 hub 设置页（`../hub/hub-styles.ts` 的
 * `dsh-hub-card*` 系列）：左侧方块 + 名称/说明两行 + 右侧控件，只有一条上边框、
 * 行与行靠各自的下边框连成整列。规则逐条照搬，只把类名前缀 `dsh-hub-` 换成
 * `dsh-progress-`，与那边互不覆盖。
 *
 * **枢纽改版了要人工同步**：两份文本没有构建期脚本或 CI 门禁比对。订阅服务调整
 * 这三行卡片的尺寸、间距、hover 或开关态时，这份文件不会自己跟上。
 *
 * ## 为什么是字符串而不是 CSS Modules
 *
 * 本插件其余线路（hub / antigravity / claude / kimi-code / step-code ……）全部走
 * `common/plugin-style.ts` 的 `installPluginStyle`：它把 CSS 作为一张带
 * `data-plugin` 归属的 <style> 注入，模块系统因此不会把这张表认领成别人的、
 * 也不会顺手删掉。CSS Modules 的 lightningcss 编译这条链路不在本插件的 tsdown
 * 配置里，所以这里与邻居保持一致，而不是把源实现的 `*.module.css` 搬过来。
 *
 * ## 配色
 *
 * 一律走 `--dsw-alias-*` 主题 token（每个都带明色兜底），暗色主题因此不需要
 * 单独一支分支。写死的只有开关滑块投影与品牌方块淡染这类"结构色"。
 */

import { installPluginStyle } from '../common/plugin-style.ts'

/** 这张表的 `data-plugin-css` 子名。 */
export const STYLE_NAME = 'progress-updates'

/** 设置卡片与面板的样式全文。 */
const CSS = `
.dsh-progress-overview{display:flex;flex-direction:column;min-width:0}
.dsh-progress-hint{color:var(--dsw-alias-label-secondary,#5d5c52);font-size:13px;line-height:1.55;margin:0 0 14px}
.dsh-progress-cards{border-top:0.5px solid var(--dsw-alias-border-l2,#eceadf)}
.dsh-progress-card{align-items:center;background:transparent;border:none;border-bottom:0.5px solid var(--dsw-alias-border-l2,#eceadf);color:var(--dsw-alias-label-primary,#141413);display:flex;gap:14px;font:inherit;min-height:68px;padding:12px 6px;text-align:left;width:100%}
.dsh-progress-card[data-enabled=false] .dsh-progress-card-name,.dsh-progress-card[data-enabled=false] .dsh-progress-card-note{opacity:.55}
.dsh-progress-card-copy{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0}
.dsh-progress-card-name{font-size:14px;font-weight:600;line-height:1.3}
.dsh-progress-card-note{color:var(--dsw-alias-label-tertiary,#8f8d84);font-size:12px;line-height:1.4}
.dsh-progress-card-note.dsh-progress-note-danger{color:var(--dsw-alias-label-danger,#d94b4b)}
.dsh-progress-card-side{align-items:center;display:flex;flex:none;gap:10px}
.dsh-progress-chevron{color:var(--dsw-alias-label-caption,#a6a094);display:inline-flex;flex:none}
.dsh-progress-brand-tile{align-items:center;background:color-mix(in srgb,var(--dsh-progress-brand,#888) 10%,transparent);border-radius:10px;color:var(--dsh-progress-brand,#888);display:inline-flex;flex:none;justify-content:center;overflow:hidden}
.dsh-progress-brand-tile>svg{display:block}
.dsh-progress-switch{background:var(--dsw-alias-bg-layer-2,#f2f1ea);border:0.5px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:999px;box-sizing:border-box;cursor:pointer;flex:none;height:24px;padding:2px;position:relative;transition:background .15s ease,border-color .15s ease;width:44px}
.dsh-progress-switch::after{background:var(--dsw-alias-switch-thumb,var(--dsw-alias-bg-layer-1,#fff));border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.28);content:"";display:block;height:19px;transition:transform .15s ease;width:19px}
.dsh-progress-switch[aria-checked=true]{background:var(--dsw-alias-button-info-fill,#397ee8);border-color:transparent}
.dsh-progress-switch[aria-checked=true]::after{transform:translateX(20px)}
.dsh-progress-switch:disabled{cursor:default;opacity:.5}
.dsh-progress-switch:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dsh-progress-number{background:var(--dsw-alias-bg-layer-1,#fff);border:0.5px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:8px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#141413);font:inherit;font-size:13px;height:30px;padding:0 8px;text-align:center;width:64px}
.dsh-progress-number:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
.dsh-progress-number:disabled{cursor:default;opacity:.5}
.dsh-progress-select{background:var(--dsw-alias-bg-layer-1,#fff);border:0.5px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:8px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#141413);cursor:pointer;font:inherit;font-size:13px;height:30px;padding:0 6px}
.dsh-progress-select:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
.dsh-progress-select:disabled{cursor:default;opacity:.5}
.dsh-progress-open{align-items:center;background:transparent;border:0.5px solid var(--dsw-alias-border-l2,#e3e1d5);border-radius:8px;color:var(--dsw-alias-label-primary,#141413);cursor:pointer;display:inline-flex;font:inherit;font-size:12px;gap:2px;padding:5px 8px}
.dsh-progress-open:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dsh-progress-open:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
`

/**
 * 安装「进展更新」设置卡片的样式表（幂等；标签归文档所有，卸载时不移除）。
 * @returns 空操作释放函数（与邻居同形）。
 */
export function installProgressUpdatesStyles(): () => void {
  return installPluginStyle(STYLE_NAME, CSS)
}
