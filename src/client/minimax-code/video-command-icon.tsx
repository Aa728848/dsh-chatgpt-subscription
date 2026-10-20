/**
 * `/video` 在斜杠菜单里的字形。
 *
 * ## 为什么是自己画一个，而不是从宿主图标集里取
 *
 * 宿主的 `CommandContribution.icon` 收的是 `ComponentType<IconProps>`
 * （`ui-commands/src/client/contract.ts:109`），而 `IconProps` 只活在
 * `@deepseek-ai/dsh-client-ui-primitives` 里——那个包的 `lib` 是宿主装配产物，
 * 本插件装不到（同 `progress-updates/markdown-lite.tsx:6` 记下的理由，也是
 * `VideoFormDialog` 自己 portal 而不是用宿主 `Modal` 的同一个原因）。
 *
 * 宿主渲染时只传 `{ size, className }` 两个 prop（`MenuView.tsx:179-184`），所以
 * 一个**结构上同形**的组件就够了：同样的 props、`currentColor` 描边、同样的
 * 16 格视框与 1px 线宽——放在宿主那排图标里看不出是外来的。
 *
 * ## 为什么是「播放三角 + 画框」
 *
 * 菜单里已经有「压缩 / 权限 / 模型 / 导出」，字形都是线稿。播放三角说明这是
 * 「产出画面」的入口，外框让它和纯播放按钮区分开：这是**生成**视频。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/minimax-code/video-command-icon
 */

import type { ComponentType } from 'react'

/** 宿主图标的 props 形状（`@deepseek-ai/dsh-client-ui-primitives` 的 `IconProps`）。 */
export interface CommandIconProps {
  /** 边长像素；缺省用字形自己的绘制尺寸。 */
  readonly size?: number | undefined
  /** 布局用的额外 class；颜色一律走 `currentColor`。 */
  readonly className?: string | undefined
}

/**
 * `/video` 的菜单字形：画框里一枚播放三角。
 *
 * @param props - 尺寸与额外 class。
 * @returns 一个 16 格视框的线稿图标。
 */
export const VideoCommandIcon: ComponentType<CommandIconProps> = ({ size = 16, className }) => (
  <svg
    width={size}
    height={size}
    className={className}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    strokeWidth={1}
  >
    <rect x="1.5" y="3.5" width="13" height="9" rx="2" stroke="currentColor" />
    <path d="M6.6 6.1 10.2 8 6.6 9.9V6.1Z" stroke="currentColor" strokeLinejoin="round" />
  </svg>
)
