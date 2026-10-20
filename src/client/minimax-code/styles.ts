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
.dshm-video-modal-root{align-items:center;display:flex;inset:0;justify-content:center;position:fixed;z-index:1000}
.dshm-video-modal-mask{background:color-mix(in srgb,var(--dsw-alias-label-primary,#000) 32%,transparent);inset:0;position:absolute}
.dshm-video-modal{background:var(--dsw-alias-bg-layer-1,#fff);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;corner-shape:round;box-shadow:0 12px 40px color-mix(in srgb,var(--dsw-alias-label-primary,#000) 18%,transparent);display:flex;flex-direction:column;max-height:82vh;max-width:560px;min-width:0;position:relative;width:calc(100% - 32px)}
.dshm-video-modal:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dshm-video-modal-head{align-items:center;border-bottom:0.5px solid var(--dsw-alias-border-l2);display:flex;gap:12px;justify-content:space-between;padding:12px 16px}
.dshm-video-modal-title{font-size:13px;font-weight:500;margin:0}
.dshm-video-modal-close{background:none;border:0;border-radius:6px;corner-shape:round;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1;padding:4px 8px}
.dshm-video-modal-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshm-video-modal-close:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:2px}
.dshm-video-modal-desc{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:0;padding:8px 16px 0}
.dshm-video-modal-body{display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto;padding:12px 16px}
.dshm-video-modal-foot{border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;gap:8px;justify-content:flex-end;padding:12px 16px}
.dshm-video-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dshm-video-field-row{display:flex;flex-wrap:wrap;gap:10px}
.dshm-video-field-row .dshm-video-field{flex:1 1 140px}
.dshm-video-field-label{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500}
.dshm-video-input{background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;corner-shape:round;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;min-width:0;padding:6px 8px;width:100%}
.dshm-video-input:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#397ee8);outline-offset:1px}
.dshm-video-textarea{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.5;resize:vertical}
.dshm-video-ratio-locked{align-items:center;display:flex;flex-wrap:wrap;gap:8px}
.dshm-video-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.dshm-video-watermark{align-items:center;flex-direction:row;gap:8px}
.dshm-video-media{border-top:0.5px solid var(--dsw-alias-border-l2);display:flex;flex-direction:column;gap:10px;padding-top:12px}
.dshm-video-media-title{font-size:12px;font-weight:500;margin:0}
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
@media(max-width:560px){.dshm-video-modal{max-height:88vh;width:calc(100% - 16px)}.dshm-video-field-row{flex-direction:column;gap:8px}}
@media(prefers-reduced-motion:reduce){.dshm-video-skeleton span{animation:none;opacity:.6}}
`, STYLE_ID)
}