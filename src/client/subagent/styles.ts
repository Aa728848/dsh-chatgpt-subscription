/**
 * 「子智能体」设置卡片的样式表。
 *
 * 1:1 对齐 DSH 官方 `ui-settings-subagent` 与 `ui-primitives` 的 CSS 规则与变量：
 * - `.dsh-subagent-section` / `.dsh-subagent-heading` 对应 `SubagentCard.module.css`
 * - `.dsh-subagent-limits-grid` / `.dsh-subagent-field` / `.dsh-subagent-input` 对应 `SubagentLimitsFields.module.css` + `fields.module.css`
 * - `.dsh-subagent-switch` 对应 `Switch.module.css`
 * - `.dsh-subagent-models` / `.dsh-subagent-group` / `.dsh-subagent-model` 对应 `SubagentModelSelectionFields.module.css`
 * - `.dsh-subagent-footer` / `.dsh-subagent-save` 对应 `SettingsForm.module.css`
 */

import { installPluginStyle } from '../common/plugin-style.ts'

/** 这张表的 `data-plugin-css` 子名。 */
export const STYLE_NAME = 'subagent'

/** 卡片与表单的样式全文。 */
export const SUBAGENT_CSS = `
.dsh-subagent-form {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.dsh-subagent-readonly-notice,
.dsh-subagent-unavailable-notice {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-subagent-section {
  min-width: 0;
  padding: 16px 0;
}

.dsh-subagent-heading {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

.dsh-subagent-limits-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
  gap: 16px;
}

.dsh-subagent-limit-cell {
  min-width: 0;
}

.dsh-subagent-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
  min-width: 0;
}

.dsh-subagent-field-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dsh-subagent-label-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.dsh-subagent-label {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

.dsh-subagent-help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: none;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}

.dsh-subagent-help-btn[aria-expanded='true'] {
  background: var(--dsw-alias-bg-layer-4);
  color: var(--dsw-alias-label-secondary);
}

@media (hover: hover) {
  .dsh-subagent-help-btn:hover {
    background: var(--dsw-alias-bg-layer-4);
    color: var(--dsw-alias-label-secondary);
  }
}

.dsh-subagent-help-box {
  padding: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}

.dsh-subagent-help-box > p {
  margin: 0;
}

.dsh-subagent-help-box > p + p {
  margin-top: 8px;
}

.dsh-subagent-depth-table {
  width: 100%;
  margin: 8px 0;
  border-collapse: collapse;
  border-block: 0.5px solid var(--dsw-alias-border-l2);
  font: inherit;
  text-align: left;
}

.dsh-subagent-depth-table th,
.dsh-subagent-depth-table td {
  padding: 6px 0;
  vertical-align: top;
}

.dsh-subagent-depth-table th {
  width: 24px;
  padding-right: 8px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
}

.dsh-subagent-depth-table tr + tr {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

.dsh-subagent-badges {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.dsh-subagent-override-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-4);
  font-size: 11px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
}

.dsh-subagent-reset-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-subagent-reset-link:hover:not(:disabled) {
    color: var(--dsw-alias-label-primary);
  }
}

.dsh-subagent-reset-link:disabled {
  cursor: default;
  opacity: 0.5;
}

.dsh-subagent-input {
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary);
  min-width: 0;
  box-sizing: border-box;
}

.dsh-subagent-input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}

.dsh-subagent-input:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

.dsh-subagent-input[aria-invalid='true'] {
  border-color: var(--dsw-alias-state-error-primary);
}

.dsh-subagent-permission {
  display: grid;
  gap: 6px;
  padding: 12px 0;
}

.dsh-subagent-toggle-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

.dsh-subagent-toggle-label {
  flex: 1;
  min-width: 0;
}

.dsh-subagent-switch {
  box-sizing: border-box;
  position: relative;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
}

.dsh-subagent-switch[aria-checked='true'] {
  background: var(--dsw-alias-brand-primary, #e06c3b);
}

.dsh-subagent-switch:disabled {
  cursor: default;
  opacity: 0.5;
}

.dsh-subagent-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}

.dsh-subagent-switch-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground, #fff);
  transition: transform 120ms ease;
}

.dsh-subagent-switch[aria-checked='false'] .dsh-subagent-switch-thumb {
  background: var(--dsw-alias-switch-thumb, #fff);
}

.dsh-subagent-switch[aria-checked='true'] .dsh-subagent-switch-thumb {
  transform: translateX(16px);
}

.dsh-subagent-selection {
  display: grid;
  gap: 12px;
  min-width: 0;
}

.dsh-subagent-target-bar {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-lg, 10px);
  background: transparent;
}

.dsh-subagent-target-bar > legend {
  padding: 0 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-subagent-select {
  height: 34px;
  width: 100%;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  box-sizing: border-box;
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-subagent-select:hover:not(:disabled) {
    border-color: var(--dsw-alias-border-l4);
    background: var(--dsw-alias-bg-layer-2);
  }
}

.dsh-subagent-select option,
.dsh-subagent-select optgroup {
  background: var(--dsw-alias-bg-layer-2, #1e1e1e);
  color: var(--dsw-alias-label-primary, #e5e5e5);
}

.dsh-subagent-select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}

.dsh-subagent-select:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}

.dsh-subagent-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dsh-subagent-chip {
  padding: 3px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-subagent-chip:hover:not(:disabled):not([aria-pressed='true']) {
    background: var(--dsw-alias-bg-layer-4);
    color: var(--dsw-alias-label-primary);
  }
}

.dsh-subagent-chip[aria-pressed='true'] {
  border-color: var(--dsw-alias-brand-primary, #e06c3b);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #e06c3b) 15%, transparent);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

.dsh-subagent-chip:disabled {
  cursor: default;
  opacity: 0.5;
}

.dsh-subagent-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l3);
}

.dsh-subagent-reset {
  padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-subagent-reset:hover:not(:disabled) {
    background: var(--dsw-alias-bg-layer-4);
    color: var(--dsw-alias-label-primary);
  }
}

.dsh-subagent-reset:disabled {
  cursor: default;
  opacity: 0.5;
}

.dsh-subagent-hint,
.dsh-subagent-notice,
.dsh-subagent-invalid {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}

.dsh-subagent-hint,
.dsh-subagent-notice {
  color: var(--dsw-alias-label-tertiary);
}

.dsh-subagent-invalid {
  color: var(--dsw-alias-state-error-primary, #e5534b);
}

.dsh-subagent-catalog-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--dsw-alias-state-error-primary, #e5534b);
}

.dsh-subagent-catalog-error button {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--dsw-alias-brand-primary, #e06c3b);
  font: inherit;
  cursor: pointer;
}

.dsh-subagent-models {
  display: grid;
  align-content: start;
  gap: 6px;
  min-width: 0;
  min-height: 180px;
  max-height: clamp(220px, calc(100dvh - 620px), 440px);
  resize: vertical;
  margin: 0;
  padding: 10px;
  overflow: auto;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-lg, 10px);
}

.dsh-subagent-models > legend {
  padding: 0 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-subagent-group {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.dsh-subagent-group + .dsh-subagent-group {
  margin-top: 4px;
  padding-top: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l3);
}

.dsh-subagent-group-name {
  padding: 0 6px;
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-subagent-model {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px;
  border-radius: var(--dsw-radius-md, 8px);
  cursor: pointer;
}

@media (hover: hover) {
  .dsh-subagent-model:hover {
    background: var(--dsw-alias-bg-layer-4);
  }
}

.dsh-subagent-model-name,
.dsh-subagent-model-route {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-subagent-model-name {
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}

.dsh-subagent-model-route {
  margin-top: 2px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}

.dsh-subagent-model-unavailable {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}

.dsh-subagent-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 16px;
}

.dsh-subagent-save {
  appearance: none;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px);
  padding: 5px 14px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}

.dsh-subagent-save:disabled {
  opacity: 0.4;
  cursor: default;
}

.dsh-subagent-save:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}

.dsh-subagent-discard {
  appearance: none;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md, 8px);
  padding: 5px 12px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}

.dsh-subagent-discard:disabled {
  opacity: 0.4;
  cursor: default;
}

.dsh-subagent-failed {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error, var(--dsw-alias-state-error-primary, #e5534b));
}
`

/**
 * 安装本卡片的样式表。
 * @returns 卸载函数（样式表由文档持有，这里不做删除）。
 */
export function installSubagentStyles(): () => void {
  return installPluginStyle(STYLE_NAME, SUBAGENT_CSS)
}
