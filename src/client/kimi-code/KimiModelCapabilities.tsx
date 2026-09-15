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
import { zh } from './locales.ts'

const t = zh

export interface KimiModelCapabilitiesProps {
  models: KimiCodeModelOption[]
}

export function KimiModelCapabilities({ models }: KimiModelCapabilitiesProps): React.ReactElement {
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
            // the table: wire, default effort and required plan.
            const facts = [
              model.id,
              model.wire === 'anthropic' ? t.wireAnthropic : t.wireOpenai,
              ...(model.defaultReasoningEffort ? [t.defaultReasoningEffort + ': ' + model.defaultReasoningEffort] : []),
              ...(model.minimumPlan ? [t.capPlan.replace('{plan}', model.minimumPlan)] : []),
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
                    : <span className="dsha-cap-off">{t.capNone}</span>}
                </td>
                <td className="dsha-cap-notes">{model.description ?? ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {models.some((model) => model.supportsVideo) && (
        <p className="dsha-muted dsha-cap-footnote">{t.capVideoFootnote}</p>
      )}
    </div>
  )
}
