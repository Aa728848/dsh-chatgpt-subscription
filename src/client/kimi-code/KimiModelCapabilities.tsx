/**
 * Capability table for the Kimi model list.
 *
 * Extracted from the settings card so the layout is testable: an earlier
 * revision inlined each capability as prose beside the model name, which
 * stretched the name column and pushed the descriptions out of alignment.
 * Capabilities are now short tags in their own columns, with the per-model
 * detail kept in a hover title.
 */
import React from 'react'
import type { KimiCodeModelOption } from '../../shared/kimi-code-contracts.ts'
import { useLineDict } from '../common/line-locale.ts'
import { effortLadder, wireLabel } from './labels.ts'
import { NS_KIMI_CODE, zh } from './locales.ts'

/**
 * Render one quota multiplier the way the official table states it: "2x", "3x".
 *
 * The value is transcribed, never computed — the service is the only party that
 * knows how a request is billed, so this shows what the model table declares.
 */
function formatMultiplier(value: number): string {
  return `${value}x`
}

export interface KimiModelCapabilitiesProps {
  models: KimiCodeModelOption[]
}

export function KimiModelCapabilities({ models }: KimiModelCapabilitiesProps): React.ReactElement {
  const t = useLineDict(NS_KIMI_CODE, zh)
  return (
    <div className="dsha-cap-table">
      <table>
        <thead>
          <tr>
            <th>{t.capabilitiesTitle}</th>
            <th>{t.capColMedia}</th>
            <th>{t.capColTools}</th>
            <th>{t.capColNotes}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => {
            // Hover text keeps the per-model facts that would otherwise bloat
            // the table: wire, the thinking declaration and ladder, default
            // effort, input cap, required plan and the quota multiplier (also
            // shown in the notes cell, because it is the one cost fact a user
            // compares across rows).
            const ladder = effortLadder(model)
            const facts = [
              model.id,
              wireLabel(model.wire, t),
              // The declaration, not a guess: a thinking-only row is named as
              // such because its own entry says so, never because of its id.
              ...(model.thinkingType === 'only' ? [t.capThinkingOnly] : []),
              ...(ladder.length === 0 ? [] : [t.capEfforts.replace('{list}', ladder.join(' / '))]),
              ...(model.defaultReasoningEffort ? [t.defaultReasoningEffort + ': ' + model.defaultReasoningEffort] : []),
              ...(model.maxInputTokens === undefined
                ? []
                : [t.capInputCap.replace('{tokens}', String(model.maxInputTokens))]),
              ...(model.minimumPlan ? [t.capPlan.replace('{plan}', model.minimumPlan)] : []),
              ...(model.quotaMultiplier === null
                ? []
                : [`${t.quotaCost}: ${formatMultiplier(model.quotaMultiplier)}`]),
            ]
            return (
              <tr key={model.id}>
                <td title={facts.join(' · ')}>{model.name}</td>
                <td>
                  <span className={model.supportsVideo ? 'dsha-cap-on' : 'dsha-cap-off'}>
                    {model.supportsVideo ? t.capVideo : t.capImageOnly}
                  </span>
                </td>
                <td>
                  {model.supportsDynamicTools
                    ? <span className="dsha-cap-on">{t.capDynamicTools}</span>
                    // Tools work but per-message disclosure does not: a dash.
                    : model.supportsToolUse
                      ? <span className="dsha-cap-off">{t.capNone}</span>
                      // No tools at all, which breaks every coding session on
                      // the model — worth naming rather than another dash.
                      : <span className="dsha-cap-off">{t.capNoTools}</span>}
                </td>
                <td className="dsha-cap-notes">
                  {model.quotaMultiplier === null
                    // An unpublished multiplier is stated, not left blank: this
                    // line is the only cost fact the table carries, so a missing
                    // line would read as a row that was skipped. No number is
                    // invented — the official table publishes none for these ids.
                    // Its own line like a published multiplier, in the tertiary
                    // "off" tone rather than the primary tone a real value gets.
                    ? <div className="dsha-cap-off">{t.quotaCost} {t.quotaUnknown}</div>
                    : (
                      <span className="dsha-cap-cost">
                        {t.quotaCost} {formatMultiplier(model.quotaMultiplier)}
                      </span>
                    )}
                  {model.description ?? ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {models.some((model) => model.supportsVideo) && (
        <p className="dsha-muted dsha-cap-footnote">{t.capVideoFootnote}</p>
      )}
      {models.some((model) => model.thinkingType === 'only') && (
        // Why the level "thinking off" is missing from the settings menu for
        // those models: the service refuses it with HTTP 400.
        <p className="dsha-muted dsha-cap-footnote">{t.capThinkingOnlyFootnote}</p>
      )}
    </div>
  )
}
