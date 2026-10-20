import { installPluginStyle } from '../common/plugin-style.ts'

export const STYLE_ID = 'dsh-minimax-code-settings-style'

/**
 * MiniMax Code-only additions to the shared settings design system.
 *
 * The base control styles (.dsha-page, .dsha-group, .dsha-row, .dsha-models,
 * the device-code box, the meter, the composer badge, ...) come from the
 * stylesheet the sibling routes install, in the same order the client installs
 * them, so this file declares only what stays unique to this card: the mono
 * credential path and the model-name list.
 */
export function installMinimaxCodeStyles(): void {
  installPluginStyle('minimax-code', `
.dshm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}
.dshm-model-list{display:flex;flex-wrap:wrap;gap:7px;padding-top:8px}
.dshm-model-list code{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;padding:5px 8px;white-space:nowrap}
.dshm-quota-note{margin-top:12px}
.dshm-reset-list{display:flex;flex-direction:column;gap:6px;padding-top:8px}
.dshm-reset-row{align-items:center;justify-content:space-between}
.dshm-reset-pick{background:none;border:0.5px solid var(--dsw-alias-border-l2);cursor:pointer;padding:4px 8px}
.dshm-reset-pick[aria-pressed="true"]{border-color:var(--dsw-alias-border-focus,var(--dsw-alias-border-l3));background:var(--dsw-alias-bg-layer-2)}

/* ---- MiniMax 视频工具卡片与侧边栏视频台 ----
 * 解剖结构照抄同仓库的 .dsh-codex-image-tool 一族（发丝线、radius 8、13px 标题、
 * 8px 状态点、虚线占位块），所以两族卡片放在一起是同一个东西。字重全部 ≤500：
 * 强调靠字号与墨色，不靠加粗。颜色只用语义 token，不新增任何色值。
 *
 * 视频台是两个界面共用的同一个外框：对话流里约 460px 宽，侧边栏里通栏。16:9 的
 * 固定比例让它在两个尺寸下都是同一个形状。 */
.dshm-video-tool{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;corner-shape:round;display:flex;flex-direction:column;gap:8px;margin:4px 0 4px 4px;max-width:520px;min-width:0;padding:10px 12px}
.dshm-video-head{align-items:center;display:flex;font-size:13px;gap:8px;min-width:0}
.dshm-video-dot{background:var(--dsw-alias-button-info-fill,#397ee8);border-radius:50%;corner-shape:round;display:inline-block;flex:none;height:8px;width:8px}
.dshm-video-tool[data-state=error] .dshm-video-dot{background:var(--dsw-alias-label-danger,#d94b4b)}
.dshm-video-title{font-weight:500;white-space:nowrap}
.dshm-video-summary{color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-video-stage{aspect-ratio:16/9;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;corner-shape:round;display:flex;min-width:0;overflow:hidden;position:relative;width:100%}
.dshm-video-stage[data-state=empty]{align-items:center;border-style:dashed;border-width:1px;justify-content:center;padding:16px}
.dshm-video-el{background:var(--dsw-alias-bg-layer-1,#000);display:block;height:100%;object-fit:contain;width:100%}
.dshm-video-placeholder{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;text-align:center}
.dshm-video-placeholder[data-tone=danger]{color:var(--dsw-alias-label-danger,#d94b4b)}
.dshm-video-foot{align-items:center;display:flex;font-size:11px;gap:10px;justify-content:space-between;min-width:0}
.dshm-video-path{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 1 auto;font:inherit;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.35;min-width:0;overflow:hidden;padding:3px 7px;text-align:left;text-overflow:ellipsis;white-space:nowrap}
.dshm-video-path:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshm-video-path:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dshm-video-meta{color:var(--dsw-alias-label-tertiary);display:flex;flex:none;font-size:11px;font-variant-numeric:tabular-nums;gap:8px;white-space:nowrap}
.dshm-video-document{display:flex;flex-direction:column;gap:10px;min-width:0;padding:16px}
.dshm-video-doc-meta{align-items:baseline;color:var(--dsw-alias-label-tertiary);display:flex;font-size:11px;gap:12px;justify-content:space-between;min-width:0}
.dshm-video-doc-name{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-video-doc-size{flex:none;font-variant-numeric:tabular-nums;white-space:nowrap}
@media(max-width:560px){.dshm-video-tool{margin-left:0;max-width:100%}.dshm-video-foot{align-items:flex-start;flex-direction:column;gap:4px}.dshm-video-document{padding:12px 10px}}
@media(prefers-reduced-motion:reduce){.dshm-video-path{transition:none}}
/* ---- /video 参数弹窗与设置页的视频分区 ----
 * 解剖结构照抄同文件的 .dshm-video-* 一族与设置卡的 .dsha-* 基础类：发丝线 0.5px、
 * radius 8 配 corner-shape:round、字号只用 11/12/13 三档、字重 ≤500、颜色只走
 * --dsw-alias-* 语义 token，不新增任何色值。
 *
 * 弹窗本身是 body portal：输入框所在的容器有 overflow，就地渲染会被裁掉。 */
/* 没有遮罩，所以这一层只是定位用的透明容器：居中、可滚动、点空白处即关闭。 */
.dshm-video-modal-root{align-items:center;display:flex;inset:0;justify-content:center;overflow:auto;padding:24px 16px;position:fixed;z-index:1000}
.dshm-video-modal{background:var(--dsw-alias-bg-layer-1,#fff);border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;corner-shape:round;box-shadow:0 2px 6px color-mix(in srgb,var(--dsw-alias-label-primary,#000) 8%,transparent),0 24px 64px color-mix(in srgb,var(--dsw-alias-label-primary,#000) 24%,transparent);display:flex;flex-direction:column;margin:auto;max-height:calc(100vh - 48px);max-width:880px;min-width:0;position:relative;width:100%}
.dshm-video-modal:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dshm-video-modal-head{align-items:baseline;display:flex;gap:12px;justify-content:space-between;padding:14px 18px 6px}
.dshm-video-modal-title{font-size:15px;font-weight:500;letter-spacing:.01em;margin:0}
.dshm-video-modal-close{background:none;border:0;border-radius:6px;corner-shape:round;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:15px;line-height:1;padding:2px 7px}
.dshm-video-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshm-video-modal-close:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dshm-video-modal-body{display:flex;flex-direction:column;gap:12px;min-height:0;overflow:auto;padding:8px 18px 14px}
/* 左栏放描述，右栏放参数与参考媒体。窄屏折成一栏，顺序不变。
 * 两栏之间留 28px：16px 时右栏的标签几乎贴到描述框的边框上。 */
.dshm-video-columns{align-items:stretch;column-gap:28px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);row-gap:16px}
.dshm-video-col-main,.dshm-video-col-side{display:flex;flex-direction:column;gap:12px;min-width:0}
/* 描述框跟着右栏一起长：右栏展开「更多参数」后，左栏空着下半截比留白更难看，
 * 而描述本来就是这块面板里最该给足空间的东西。 */
.dshm-video-col-main .dshm-video-field{flex:1 1 auto;min-height:0;max-height:520px}
.dshm-video-col-main .dshm-video-prompt{flex:1 1 auto;height:auto;min-height:200px;max-height:520px}
.dshm-video-col-side .dshm-video-media{max-height:none}
@media(max-width:720px){.dshm-video-columns{grid-template-columns:minmax(0,1fr)}}
.dshm-video-modal-foot{align-items:center;border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;gap:8px;padding:12px 18px}
.dshm-video-foot-hint{color:var(--dsw-alias-label-tertiary);flex:1 1 auto;font-size:11px;line-height:1.45;min-width:0}
.dshm-video-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshm-video-field-row{display:flex;flex-wrap:wrap;gap:10px}
.dshm-video-field-row .dshm-video-field{flex:1 1 132px}
.dshm-video-field-label{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500}
/* 提示与标签同一行，但要能换行：右栏就在旁边，挤不下时宁可掉到下一行。 */
.dshm-video-prompt-head{align-items:baseline;display:flex;flex-wrap:wrap;gap:2px 8px;justify-content:space-between}
.dshm-video-prompt-head .dshm-video-hint{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 描述是这块面板唯一必填的东西，所以它拿到最大的字号与最松的行高。 */
.dshm-video-prompt{font-size:13px;line-height:1.6;min-height:88px;padding:9px 10px;resize:vertical}
/* box-sizing 必须写死：没有它，width:100% 加上左右内边距就会把输入框顶出栏宽，
 * 文字一路压到隔壁栏的标签上。 */
.dshm-video-input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;box-sizing:border-box;corner-shape:round;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;min-width:0;padding:6px 8px;width:100%}
.dshm-video-input:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
.dshm-video-textarea{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.5;resize:vertical}
.dshm-video-ratio-locked{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
.dshm-video-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.dshm-video-hint[data-tone=danger]{color:var(--dsw-alias-label-danger,#d94b4b)}
.dshm-video-watermark{align-items:center;flex-direction:row;gap:8px}
/* 档位胶囊：三选一，所以永远同一行、等宽——换行会让它读起来像两组。
 * 选中的那一档描边加深，与下面的选择器相互印证。 */
.dshm-video-tiers{display:grid;gap:6px;grid-auto-columns:1fr;grid-auto-flow:column}
.dshm-video-tier{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px;min-width:0;overflow:hidden;padding:5px 8px;text-align:center;text-overflow:ellipsis;transition:background .12s ease,border-color .12s ease,color .12s ease;white-space:nowrap}
.dshm-video-tier:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshm-video-tier[aria-pressed=true]{border-color:var(--dsw-alias-button-info-fill,#397ee8);color:var(--dsw-alias-label-primary)}
.dshm-video-tier:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
/* 「更多参数」：默认收起，展开后是水印与参考媒体。 */
.dshm-video-advanced{align-items:center;align-self:flex-start;background:none;border:0;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;font:inherit;font-size:11px;gap:6px;padding:2px 0}
.dshm-video-advanced:hover{color:var(--dsw-alias-label-primary)}
.dshm-video-advanced:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dshm-video-advanced-caret{font-size:9px;line-height:1}
.dshm-video-advanced-count{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:10px;line-height:1;padding:2px 6px}
.dshm-video-advanced-body{border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:12px;padding-top:12px}
.dshm-video-media{display:flex;flex-direction:column;gap:10px}
.dshm-video-media-title{font-size:12px;font-weight:500;margin:0}
/* 远端参考视频的时长：每条链接一行，因为宿主读不到它的长度。 */
.dshm-video-durations{display:flex;flex-direction:column;gap:6px}
.dshm-video-duration-row{align-items:center;display:flex;gap:8px;justify-content:space-between}
.dshm-video-duration-row .dshm-video-field-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-video-duration-row .dshm-video-input{flex:0 0 96px;width:96px}
/* 媒体块：标题行 + 一块可拖入的洼地。 */
.dshm-media-block{display:flex;flex-direction:column;gap:5px;min-width:0}
.dshm-media-head{align-items:center;display:flex;gap:8px;justify-content:space-between}
.dshm-media-label{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500}
.dshm-media-browse{background:none;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:11px;padding:3px 9px}
.dshm-media-browse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshm-media-browse:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
/* 文件输入只需要被按钮点开，不需要出现在版面上。 */
.dshm-media-file{display:none}
/* 拖拽区与输入行合并在同一块里：已收下的标签在上，输入行贴底。 */
.dshm-media-well{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;corner-shape:round;display:flex;flex-direction:column;gap:6px;min-height:38px;min-width:0;padding:6px 6px 6px 7px;position:relative;transition:border-color .12s ease,background .12s ease}
.dshm-media-well[data-dragging=true]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-button-info-fill,#397ee8);border-style:dashed}
.dshm-media-well:focus-within{border-color:var(--dsw-alias-button-info-fill,#397ee8)}
.dshm-media-placeholder{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshm-media-entry{align-items:center;display:flex;gap:6px;min-width:0}
.dshm-media-entry-input{background:transparent;border:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);flex:1 1 auto;font:inherit;font-size:11px;min-width:0;outline:none;padding:3px 2px}
.dshm-media-entry-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshm-media-add{background:none;border:0.5px solid var(--dsw-alias-border-l2);border-radius:5px;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;font:inherit;font-size:11px;padding:2px 8px}
.dshm-media-add:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshm-media-add:disabled{cursor:default;opacity:.4}
.dshm-media-add:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
/* @ 候选：贴在输入行下方，浮起来而不是把下面的内容顶开。 */
.dshm-media-suggest{background:var(--dsw-alias-bg-layer-1,#fff);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 10px 28px color-mix(in srgb,var(--dsw-alias-label-primary,#000) 22%,transparent);display:flex;flex-direction:column;left:0;list-style:none;margin:0;max-height:180px;overflow:auto;padding:4px;position:absolute;right:0;top:calc(100% - 2px);z-index:2}
.dshm-media-suggest-item{align-items:center;background:none;border:0;border-radius:5px;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;font:inherit;font-size:11px;gap:8px;justify-content:space-between;padding:5px 7px;text-align:left;width:100%}
.dshm-media-suggest-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshm-media-suggest-item:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:-2px}
.dshm-media-suggest-name{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-media-suggest-kind{color:var(--dsw-alias-label-tertiary);flex:none;font-size:10px}
.dshm-media-items{display:flex;flex-wrap:wrap;gap:5px;list-style:none;margin:0;padding:0}
.dshm-media-item{align-items:center;background:var(--dsw-alias-bg-layer-1,#fff);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;display:flex;gap:4px;max-width:100%;padding:2px 3px 2px 7px}
.dshm-media-item-name{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-media-remove{background:none;border:0;border-radius:4px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1;padding:1px 4px}
.dshm-media-remove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshm-media-remove:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
/* 手填一行：路径输入 + 添加按钮。拖拽与粘贴之外，总有人手上正好有一条路径。 */
.dshm-media-manual{align-items:center;display:flex;gap:6px}
.dshm-media-manual-input{flex:1 1 auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;min-width:0}
.dshm-media-manual .dshm-media-browse{flex:none}
.dshm-media-manual .dshm-media-browse:disabled{cursor:default;opacity:.45}
.dshm-video-issue{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;margin:0}
.dshm-video-issue[data-tone=danger]{color:var(--dsw-alias-label-danger,#d94b4b)}
/* 列表的加载态：骨架，不是 loading 文案。 */
.dshm-video-skeleton{display:flex;flex-direction:column;gap:6px;padding:10px 0}
.dshm-video-skeleton span{animation:dshm-video-pulse 1.4s ease-in-out infinite;background:var(--dsw-alias-bg-layer-2);border-radius:6px;corner-shape:round;display:block;height:14px}
.dshm-video-skeleton span:nth-child(2){opacity:.7;width:82%}
.dshm-video-skeleton span:nth-child(3){opacity:.45;width:64%}
@keyframes dshm-video-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.dshm-video-history{display:flex;flex-direction:column;min-width:0}
.dshm-video-history-path{color:var(--dsw-alias-label-secondary);flex:1 1 auto;font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-video-history-meta{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px;font-variant-numeric:tabular-nums}
@media(max-width:560px){.dshm-video-modal-root{padding:12px 8px}.dshm-video-modal{max-height:calc(100vh - 24px)}.dshm-video-field-row{flex-direction:column;gap:8px}.dshm-video-foot-hint{display:none}}
@media(prefers-reduced-motion:reduce){.dshm-video-skeleton span{animation:none;opacity:.6}}
`, STYLE_ID)
}