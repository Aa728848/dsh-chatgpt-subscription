/**
 * `code_run` 工具行样式表 —— 对齐宿主内置 `run_code`（`DisclosureRow` + `ToolRow` +
 * `CodeBlock` + `CodeToolbar`）的视觉令牌与排版节奏。
 *
 * 所有颜色、字号与圆角均直接引用宿主 `--dsw-*` / `--dsh-*` / `--shiki-*` CSS 变量。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/codemode/styles
 */

import { installPluginStyle } from '../common/plugin-style.ts'

export const CODEMODE_CSS = `
.dshc-code-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
}

.dshc-code-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.dshc-code-header {
  display: flex;
  align-items: center;
  min-width: 0;
}

.dshc-code-row {
  flex: 1 1 auto;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  height: calc(24px + var(--dsh-content-font-delta, 0px));
  min-width: 0;
  color: var(--dsw-alias-label-tertiary, #8a9099);
  transition: color 100ms ease;
  user-select: none;
}

.dshc-code-row[data-expandable='true'] {
  cursor: pointer;
}

@media (hover: hover) {
  .dshc-code-row:hover {
    color: var(--dsw-alias-label-secondary, #5b6270);
  }
}

.dshc-code-row:focus-visible {
  outline: 1px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: 2px;
  border-radius: var(--dsw-radius-sm, 4px);
}

.dshc-code-leading {
  position: relative;
  flex: none;
  width: calc(16px + var(--dsh-content-font-delta, 0px));
  height: calc(16px + var(--dsh-content-font-delta, 0px));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-right: 6px;
  color: inherit;
}

.dshc-code-leading svg {
  width: calc(14px + var(--dsh-content-font-delta, 0px));
  height: calc(14px + var(--dsh-content-font-delta, 0px));
}

.dshc-code-icon-idle {
  display: inline-flex;
  opacity: 1;
  transition: opacity 100ms ease;
}

.dshc-code-chevron-hover {
  position: absolute;
  inset: 0;
  margin: auto;
  opacity: 0;
  transition: opacity 100ms ease;
}

@media (hover: hover) {
  .dshc-code-row[data-expandable='true']:hover .dshc-code-icon-idle {
    opacity: 0;
  }
  .dshc-code-row[data-expandable='true']:hover .dshc-code-chevron-hover {
    opacity: 1;
  }
}

.dshc-code-text-flow {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}

@keyframes dshc-shimmer-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

.dshc-code-text-flow[data-running='true'] {
  animation: dshc-shimmer-pulse 1.6s ease-in-out infinite;
}

.dshc-code-title {
  flex: none;
  font-weight: 400;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: inherit;
}

.dshc-code-sep {
  flex: none;
  width: 2px;
  height: 2px;
  border-radius: 1px;
  margin: 0 8px;
  background: var(--dsw-alias-label-caption, #8a9099);
}

.dshc-code-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}

.dshc-code-summary[data-state='error'] {
  color: var(--dsw-alias-state-error-primary, #d54941);
}

.dshc-code-summary[data-state='stopped'] {
  color: var(--dsw-alias-state-warn-label, #d97706);
}

.dshc-code-body-wrap {
  display: flex;
  flex-direction: column;
}

.dshc-code-body-scroll {
  max-height: 260px;
  overflow-y: auto;
  margin: 4px 0 4px 4px;
  border-radius: var(--dsw-radius-lg, 10px);
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  background: var(--dsw-alias-markdown-code-block, rgba(128, 128, 128, 0.08));
}

.dshc-code-card {
  position: relative;
  color: var(--dsw-alias-label-primary, inherit);
  background: transparent;
  font: var(--dsw-font-markdown-code-block, 13px/20px var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace));
}

.dshc-code-toolbar {
  position: sticky;
  top: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px 8px 22px;
  background: var(--dsw-alias-markdown-code-block, #1e222a);
  color: var(--dsw-alias-label-secondary, #8a9099);
  font: 11px/18px var(--dsw-font-family, system-ui, sans-serif);
}

.dshc-code-lang {
  color: var(--dsw-alias-label-tertiary, #8a9099);
  flex: none;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
}

.dshc-code-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.dshc-code-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 4px);
  color: var(--dsw-alias-label-secondary, #8a9099);
  background: transparent;
  cursor: pointer;
}

@media (hover: hover) {
  .dshc-code-action:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.14));
    color: var(--dsw-alias-label-primary, inherit);
  }
}

.dshc-code-action:focus-visible {
  outline: 1px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: 2px;
}

.dshc-code-pre {
  margin: 0 !important;
  padding: 6px 22px 20px;
  font: var(--dsw-font-markdown-code-block, 13px/20px var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace));
  background: transparent !important;
  color: var(--shiki-foreground, var(--dsw-alias-label-primary, inherit));
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: normal;
  overflow-wrap: anywhere;
}

.dshc-code-card[data-code-wrap='false'] .dshc-code-pre {
  white-space: pre;
  overflow-wrap: normal;
}

.dshc-code-pre code {
  font: inherit;
  background: none;
  padding: 0;
}

.dshc-code-io-card {
  display: flex;
  flex-direction: column;
  margin: 4px 0 4px 4px;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.18));
  border-radius: var(--dsw-radius-lg, 10px);
  background: var(--dsw-alias-markdown-code-block, rgba(128, 128, 128, 0.08));
  font: var(--dsw-font-markdown-code-block-small, 12px/18px var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace));
}

.dshc-code-io-section {
  display: grid;
  grid-template-columns: max-content 1fr;
  column-gap: 14px;
  align-items: baseline;
  padding: 12px 16px;
  max-height: 150px;
  overflow-y: auto;
}

.dshc-code-io-label {
  position: sticky;
  top: 0;
  align-self: start;
  color: var(--dsw-alias-label-caption, #8a9099);
}

.dshc-code-io-text {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary, #8a9099);
}

.dshc-code-io-text[data-error='true'] {
  color: var(--dsw-alias-state-error-primary, #d54941);
}

.dshc-code-inspect-btn {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 4px;
  margin: 4px 0 2px 4px;
  padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.25));
  border-radius: 999px;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-secondary, #8a9099);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 100ms ease;
}

.dshc-code-inspect-btn:focus-visible {
  opacity: 1;
}

@media (hover: hover) {
  .dshc-code-root:hover .dshc-code-inspect-btn {
    opacity: 1;
  }
  .dshc-code-inspect-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover-solid, rgba(128, 128, 128, 0.18));
    color: var(--dsw-alias-label-primary, inherit);
  }
}

@media (hover: none) {
  .dshc-code-inspect-btn {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dshc-code-row,
  .dshc-code-text-flow[data-running='true'] {
    transition: none;
    animation: none;
  }
}
`

export function installCodemodeStyles(): () => void {
  return installPluginStyle('codemode', CODEMODE_CSS)
}
