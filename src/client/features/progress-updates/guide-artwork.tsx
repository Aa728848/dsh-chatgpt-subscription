/**
 * 右侧栏 guide 页里「进展更新」那一格用的彩色标记。
 *
 * 为什么自带颜色：guide 的图标槽位收的是 `ComponentType<IconProps>`，平台自家的
 * 那几个（`plugin-artwork.tsx` 的 PluginArtworkTerminal / Loop / Subagent / Search）
 * 都**不骑 currentColor**，各自带品牌色与渐变——截图里那四格的颜色差异就是这么来的。
 * 所以这里照它们的样子画：36×36 viewBox、{size, className}、固定调色板。
 *
 * 图形语义：一条向上的折线（进展）加一个末端的箭头，与对话流里那一行的「状态点 +
 * 标题」互为同一件事的两种画法。渐变用 useId 生成前缀，避免同页多实例时
 * `url(#…)` 全部解析到第一个实例。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/progress-updates/guide-artwork
 */

import { useId } from 'react'

/** 图标组件的入参，与平台 `IconProps` 同形（本包不依赖 ui-primitives 的运行时包）。 */
export interface GuideArtworkProps {
  /** 边长（px）。guide 里平台传 36。 */
  size?: number
  /** 追加的类名。 */
  className?: string
}

/**
 * 「进展更新」的彩色标记：一条攀升的折线，末端带箭头。
 * @param props - 尺寸与类名。
 * @returns 36×36 的彩色 SVG。
 */
export function ProgressUpdatesArtwork({ size = 36, className }: GuideArtworkProps): React.JSX.Element {
  const uid = `dsh_progress_art_${useId().replaceAll(':', '')}`
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* 底板：淡色圆角方块，让它在 guide 的深色背景上有一块自己的区域 */}
      <rect x="3" y="3" width="30" height="30" rx="9" fill={`url(#${uid}bg)`} fillOpacity="0.18" />
      {/* 折线：三段攀升，颜色由深到浅，读作「一步步推进」 */}
      <path
        d="M9.5 24.2L15 18.6L19.2 22.2L26.5 13.4"
        stroke={`url(#${uid}line)`}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 末端箭头：与折线终点相接 */}
      <path d="M21.6 12.8H27.2V18.4" stroke="#7C6AEF" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      <defs>
        <linearGradient id={`${uid}bg`} x1="3" y1="3" x2="33" y2="33" gradientUnits="userSpaceOnUse">
          <stop stopColor="#658EFF" />
          <stop offset="1" stopColor="#A797FC" />
        </linearGradient>
        <linearGradient id={`${uid}line`} x1="9.5" y1="24.2" x2="26.5" y2="13.4" gradientUnits="userSpaceOnUse">
          <stop stopColor="#4561EE" />
          <stop offset="1" stopColor="#7C6AEF" />
        </linearGradient>
      </defs>
    </svg>
  )
}
