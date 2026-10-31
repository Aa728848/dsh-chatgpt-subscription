/**
 * 「子智能体」设置卡片：运行限制 + 模型选择（全局默认 + 按主代理模型覆盖）。
 *
 * 1:1 还原 DSH 官方 `@deepseek-ai/dsh-client-ui-settings-subagent` 的 DOM 层次与样式：
 * - 运行限制：双列响应式网格，标题旁带 `?` 帮助按钮（展开显示深度说明表格），全宽数字输入框；
 * - 模型选择：官方胶囊开关、主代理模型切换栏、以及带滚动条（max-height: 280px）和提供方分隔线的子智能体模型勾选框；
 * - 保存栏：左对齐保存按钮，卸载页面时自动丢弃未保存草稿。
 *
 * @module @eddyskywalker/dsh-chatgpt-subscription/client/subagent/SubagentCard
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { GLOBAL_TARGET, type SubagentSettingsInjected, type SubagentSettingsState } from './subagent-card-controller.ts'
import { NS_SUBAGENT } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'plugins.item': {
      kind: 'list'
      scope: 'root'
      owner: { readonly view: 'summary' | 'page'; readonly form?: unknown }
    }
  }
}

/** 卡片 props：框架座位 + 本卡命名空间的 t + 注入的状态与动作。 */
export type SubagentCardProps = PropsRuntime<'plugins.item'>
  & PropsLocale<typeof NS_SUBAGENT>
  & InjectFace<SubagentSettingsInjected>

/** 把 {count} 占位符换成一个数。 */
function withCount(template: string, count: number): string {
  return template.replace('{count}', String(count))
}

/** 与官方 IconInfoOutlineRegular 一致的 12px 信息圆圈图标。 */
function InfoIcon(): ReactNode {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.2V11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.75" fill="currentColor" />
    </svg>
  )
}

/** 一行模型勾选项（1:1 复刻官方 SubagentModelSelectionFields 的 renderCandidate）。 */
function ModelRow(props: {
  candidate: SubagentSettingsState['candidates'][number]
  disabled: boolean
  unavailableLabel: string
  onToggle: (key: string) => void
}) {
  const { candidate } = props
  return (
    <label className="dsh-subagent-model" data-dsh-part="subagent-model">
      <input
        type="checkbox"
        checked={candidate.selected}
        disabled={props.disabled}
        aria-label={candidate.providerName + ' ' + candidate.modelName}
        onChange={() => { props.onToggle(candidate.key) }}
      />
      <span>
        <span className="dsh-subagent-model-name">{candidate.modelName}</span>
        <span className="dsh-subagent-model-route">{candidate.providerName + ' · ' + candidate.provider + '/' + candidate.model}</span>
      </span>
      {candidate.available ? null : <span className="dsh-subagent-model-unavailable">{props.unavailableLabel}</span>}
    </label>
  )
}

/** 1:1 复刻官方 SettingsValueField：标签 + 帮助按钮 + 已覆盖徽标/恢复默认 + 全宽输入框。 */
function LimitField(props: {
  id: string
  label: string
  helpLabel: string
  helpContent: ReactNode
  value: string
  overridden: boolean
  overriddenLabel: string
  resetLabel: string
  invalidLabel: string
  invalid: boolean
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
}) {
  const [helpOpen, setHelpOpen] = useState(false)
  const helpId = props.id + '-help'
  const messageId = props.id + '-message'
  const description = [props.invalid ? messageId : '', helpOpen ? helpId : ''].filter(Boolean).join(' ')
  return (
    <div className="dsh-subagent-field" data-dsh-part={props.id}>
      <div className="dsh-subagent-field-head">
        <div className="dsh-subagent-label-group">
          <label className="dsh-subagent-label" htmlFor={props.id}>{props.label}</label>
          <button
            type="button"
            className="dsh-subagent-help-btn"
            aria-label={props.helpLabel}
            aria-expanded={helpOpen}
            aria-controls={helpId}
            onClick={() => { setHelpOpen(!helpOpen) }}
          >
            <InfoIcon />
          </button>
        </div>
        {props.overridden
          ? (
            <span className="dsh-subagent-badges">
              <span className="dsh-subagent-override-tag">{props.overriddenLabel}</span>
              <button
                type="button"
                className="dsh-subagent-reset-link"
                data-dsh-part={props.id + '-reset'}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={props.id}
        type="text"
        inputMode="numeric"
        className="dsh-subagent-input"
        aria-label={props.label}
        aria-describedby={description || undefined}
        {...(props.invalid ? { 'aria-invalid': true } : {})}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      {props.invalid
        ? <p id={messageId} className="dsh-subagent-invalid" role="alert">{props.invalidLabel}</p>
        : null}
      {helpOpen
        ? <div id={helpId} className="dsh-subagent-help-box" role="region" aria-label={props.helpLabel}>{props.helpContent}</div>
        : null}
    </div>
  )
}

/**
 * 渲染子智能体设置。
 * @param props - 框架座位、t，以及注入的快照与动作。
 * @returns summary 时是一句简介，page 时是整张表单。
 */
export function SubagentCard(props: SubagentCardProps): ReactNode {
  const { t } = props
  const state: SubagentSettingsState = useSyncExternalStore(
    props.store.subscribe,
    props.store.getSnapshot,
    props.store.getSnapshot,
  )
  const headingId = useId()
  const discardRef = useRef(props.discard)
  discardRef.current = props.discard
  useEffect(() => () => {
    if (props.view === 'page') discardRef.current()
  }, [props.view])

  // summary：一句话简介，不带任何控件。
  if (props.view === 'summary') return <>{t('subagentDescription')}</>

  if (!state.available) {
    return <p className="dsh-subagent-unavailable-notice" role="status">{t('unavailable')}</p>
  }

  const disabled = !state.writable || state.saving
  const groups = new Map<string, { providerName: string; rows: SubagentSettingsState['candidates'][number][] }>()
  const unavailable: SubagentSettingsState['candidates'][number][] = []
  for (const candidate of state.candidates) {
    if (!candidate.available) {
      unavailable.push(candidate)
      continue
    }
    const group = groups.get(candidate.provider)
    if (group === undefined) groups.set(candidate.provider, { providerName: candidate.providerName, rows: [candidate] })
    else group.rows.push(candidate)
  }

  /** 主代理模型的显示名：目录里有就用目录的，没有就用键本身。 */
  const mainModelName = (key: string): string => {
    for (const group of state.mainModelGroups) {
      for (const model of group.models) {
        if (model.key === key) return model.modelName
      }
    }
    return key
  }

  const activeModelKey = state.activeTarget
  const overrideKeys = Object.keys(state.overridesByMainModel)
  const limitsHeadingId = headingId + '-limits'
  const modelsHeadingId = headingId + '-models'
  const mainModelId = headingId + '-main-model'
  const blocked = !state.dirty || state.invalid || state.saving || !state.writable

  return (
    <div className="dsh-subagent-form" data-dsh-plugin="subagent" data-dsh-part="subagent-form">
      {!state.writable ? <p className="dsh-subagent-readonly-notice" role="status">{t('readOnly')}</p> : null}

      <section className="dsh-subagent-section" aria-labelledby={limitsHeadingId}>
        <h3 className="dsh-subagent-heading" id={limitsHeadingId}>{t('subagentLimitsTitle')}</h3>
        <div className="dsh-subagent-limits-grid">
          <div className="dsh-subagent-limit-cell">
            <LimitField
              id="plugin-config-subagent-depth"
              label={t('subagentMaxDepth')}
              helpLabel={t('subagentDepthHelpLabel')}
              helpContent={(
                <>
                  <p>{t('subagentDepthHelp')}</p>
                  <table className="dsh-subagent-depth-table" aria-label={t('subagentDepthHelpLabel')}>
                    <tbody>
                      <tr>
                        <th scope="row">{0}</th>
                        <td>{t('subagentDepthZero')}</td>
                      </tr>
                      <tr>
                        <th scope="row">{1}</th>
                        <td>{t('subagentDepthOne')}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p>{t('subagentDepthOverride')}</p>
                </>
              )}
              value={state.maxDepth.value}
              overridden={state.maxDepth.overridden}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('subagentDepthInvalid')}
              invalid={state.maxDepth.invalid}
              disabled={disabled}
              onEdit={(text) => { props.editLimit('maxDepth', text) }}
              onReset={() => { props.resetLimit('maxDepth') }}
            />
          </div>
          <div className="dsh-subagent-limit-cell">
            <LimitField
              id="plugin-config-subagent-capacity"
              label={t('subagentMaxActive')}
              helpLabel={t('subagentCapacityHelpLabel')}
              helpContent={<p>{t('subagentCapacityHelp')}</p>}
              value={state.maxActiveSubagents.value}
              overridden={state.maxActiveSubagents.overridden}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('subagentCapacityInvalid')}
              invalid={state.maxActiveSubagents.invalid}
              disabled={disabled}
              onEdit={(text) => { props.editLimit('maxActiveSubagents', text) }}
              onReset={() => { props.resetLimit('maxActiveSubagents') }}
            />
          </div>
        </div>
      </section>

      <section className="dsh-subagent-section" aria-labelledby={modelsHeadingId}>
        <h3 className="dsh-subagent-heading" id={modelsHeadingId}>{t('subagentModelSelectionTitle')}</h3>
        <div className="dsh-subagent-permission">
          <div className="dsh-subagent-toggle-row">
            <span className="dsh-subagent-toggle-label">{t('subagentModelSelectionToggle')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={state.enabled}
              aria-label={t('subagentModelSelectionToggle')}
              className="dsh-subagent-switch"
              data-dsh-part="subagent-enabled-switch"
              disabled={disabled}
              onClick={() => { props.toggleEnabled() }}
            >
              <span className="dsh-subagent-switch-thumb" />
            </button>
          </div>
          <p className="dsh-subagent-hint">
            {t(state.enabled ? 'subagentModelSelectionChoose' : 'subagentModelSelectionOff')}
          </p>
        </div>

        {state.enabled
          ? (
            <div className="dsh-subagent-selection" data-dsh-part="subagent-target">
              <fieldset className="dsh-subagent-target-bar">
                <legend>{t('subagentMainModelLabel')}</legend>
                <select
                  id={mainModelId}
                  className="dsh-subagent-select"
                  data-dsh-part="subagent-main-model"
                  aria-label={t('subagentMainModelLabel')}
                  value={activeModelKey}
                  disabled={disabled}
                  onChange={(event) => { props.setActiveTarget(event.target.value) }}
                >
                  <option value={GLOBAL_TARGET}>{t('subagentMainModelGlobalOption')}</option>
                  {state.mainModelGroups.map(group => (
                    <optgroup key={group.provider} label={group.providerName}>
                      {group.models.map(model => (
                        <option key={model.key} value={model.key}>
                          {model.modelName + ' · ' + model.key + (model.overridden ? t('subagentOverrideBadge') : '')}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  {state.orphanMainModels.length > 0
                    ? (
                      <optgroup label={t('subagentModelSelectionUnavailableGroup')}>
                        {state.orphanMainModels.map(key => (
                          <option key={key} value={key}>
                            {mainModelName(key) + ' · ' + key + t('subagentOverrideBadge')}
                          </option>
                        ))}
                      </optgroup>
                    )
                    : null}
                </select>

                <div className="dsh-subagent-chips" data-dsh-part="subagent-chips" aria-label={t('subagentMainModelQuickSwitch')}>
                  <button
                    type="button"
                    className="dsh-subagent-chip"
                    data-dsh-part="subagent-chip-global"
                    aria-pressed={activeModelKey === GLOBAL_TARGET}
                    disabled={disabled}
                    onClick={() => { props.setActiveTarget(GLOBAL_TARGET) }}
                  >
                    {withCount(t('subagentChipGlobal'), state.defaultCount)}
                  </button>
                  {overrideKeys.map(key => (
                    <button
                      key={key}
                      type="button"
                      className="dsh-subagent-chip"
                      data-dsh-part="subagent-chip-override"
                      aria-pressed={activeModelKey === key}
                      disabled={disabled}
                      onClick={() => { props.setActiveTarget(key) }}
                    >
                      {mainModelName(key) + ' (' + String(state.overridesByMainModel[key]?.length ?? 0) + ')'}
                    </button>
                  ))}
                </div>

                <div className="dsh-subagent-status" data-dsh-part="subagent-target-status">
                  {activeModelKey === GLOBAL_TARGET
                    ? <p className="dsh-subagent-hint">{t('subagentTargetGlobalHint')}</p>
                    : state.activeTargetOverridden
                      ? (
                        <p className="dsh-subagent-hint">
                          {withCount(t('subagentTargetOverrideStatus'), state.activeTargetCount)}
                        </p>
                      )
                      : <p className="dsh-subagent-hint">{t('subagentTargetFollowGlobalStatus')}</p>}
                  {activeModelKey !== GLOBAL_TARGET && state.activeTargetOverridden
                    ? (
                      <button
                        type="button"
                        className="dsh-subagent-reset"
                        data-dsh-part="subagent-reset-to-global"
                        disabled={disabled}
                        onClick={() => { props.resetActiveTarget() }}
                      >
                        {t('subagentResetToGlobal')}
                      </button>
                    )
                    : null}
                </div>
              </fieldset>

              {state.catalogStatus === 'loading'
                ? <p className="dsh-subagent-notice" role="status">{t('subagentModelSelectionLoading')}</p>
                : null}
              {state.catalogStatus === 'error'
                ? (
                  <div className="dsh-subagent-catalog-error" role="alert">
                    <span>{t('subagentModelSelectionLoadFailed')}</span>
                    <button
                      type="button"
                      data-dsh-part="subagent-retry-catalog"
                      disabled={state.saving}
                      onClick={() => { props.retryCatalog() }}
                    >
                      {t('subagentModelSelectionRetry')}
                    </button>
                  </div>
                )
                : null}
              {state.catalogPartial ? <p className="dsh-subagent-notice">{t('subagentModelSelectionPartial')}</p> : null}

              {state.candidates.length > 0
                ? (
                  <fieldset className="dsh-subagent-models">
                    <legend>{t('subagentModelSelectionAllowed')}</legend>
                    {[...groups].map(([provider, group]) => (
                      <div key={provider} className="dsh-subagent-group">
                        <div className="dsh-subagent-group-name">{group.providerName}</div>
                        {group.rows.map(candidate => (
                          <ModelRow
                            key={candidate.key}
                            candidate={candidate}
                            disabled={disabled}
                            unavailableLabel={t('subagentModelSelectionUnavailable')}
                            onToggle={(key) => { props.toggleModel(key) }}
                          />
                        ))}
                      </div>
                    ))}
                    {unavailable.length > 0
                      ? (
                        <div className="dsh-subagent-group">
                          <div className="dsh-subagent-group-name">{t('subagentModelSelectionUnavailableGroup')}</div>
                          {unavailable.map(candidate => (
                            <ModelRow
                              key={candidate.key}
                              candidate={candidate}
                              disabled={disabled}
                              unavailableLabel={t('subagentModelSelectionUnavailable')}
                              onToggle={(key) => { props.toggleModel(key) }}
                            />
                          ))}
                        </div>
                      )
                      : null}
                  </fieldset>
                )
                : state.catalogStatus === 'ready'
                  ? <p className="dsh-subagent-notice">{t('subagentModelSelectionEmpty')}</p>
                  : null}

              {state.invalid
                ? <p className="dsh-subagent-invalid" role="alert">{t('subagentModelPerTargetRequired')}</p>
                : null}
            </div>
          )
          : null}
      </section>

      <div className="dsh-subagent-footer" data-dsh-part="subagent-footer">
        <button
          type="button"
          className="dsh-subagent-save"
          data-dsh-part="subagent-save"
          disabled={blocked}
          onClick={() => { props.save() }}
        >
          {state.saving ? t('saving') : t('save')}
        </button>
        {state.dirty
          ? (
            <button
              type="button"
              className="dsh-subagent-discard"
              data-dsh-part="subagent-discard"
              disabled={state.saving}
              onClick={() => { props.discard() }}
            >
              {t('discard')}
            </button>
          )
          : null}
        {state.failed ? <p className="dsh-subagent-failed" role="alert">{t('saveFailed')}</p> : null}
      </div>
    </div>
  )
}
