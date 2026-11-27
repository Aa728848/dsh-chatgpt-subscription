import type { ClaudeMaxOutputKey } from '../../../shared/claude-contracts.ts'

export interface MaxOutputRow {
  id: string
  name: string
  /** The route's limit when nothing is saved, shown as the "all levels" placeholder. */
  defaultLabel: string
  /** Levels this model accepts, in order; `default` is always shown first. */
  levels: readonly ClaudeMaxOutputKey[]
  drafts: Partial<Record<ClaudeMaxOutputKey, string>>
  hasOverride: boolean
  saving: boolean
}

export interface MaxOutputLabels {
  levels: Record<ClaudeMaxOutputKey, string>
  inherit: string
  save: string
  saving: string
  reset: string
  empty: string
}

interface Props {
  rows: MaxOutputRow[]
  labels: MaxOutputLabels
  onDraftChange(id: string, key: ClaudeMaxOutputKey, draft: string): void
  onCommit(id: string): void
  onReset(id: string): void
}

/** One row per enabled model: an output limit for all levels, and one per thinking level. */
export function MaxOutputEditor({ rows, labels, onDraftChange, onCommit, onReset }: Props): React.JSX.Element {
  return <div className="dsha-context-settings">
    {rows.length === 0 ? <p className="dsha-muted">{labels.empty}</p> : null}
    {rows.map((row) => (
      <div key={row.id} className="dsha-context-row dshcl-max-output-row">
        <span title={row.id}>{row.name}</span>
        <div className="dshcl-max-output-levels">
          {(['default', ...row.levels.filter(level => level !== 'default')] as ClaudeMaxOutputKey[]).map((level) => (
            <label key={level} className="dshcl-max-output-level">
              <small>{labels.levels[level]}</small>
              <input
                type="text"
                aria-label={`${row.name} ${labels.levels[level]}`}
                value={row.drafts[level] ?? ''}
                placeholder={level === 'default' ? row.defaultLabel : labels.inherit}
                onChange={(event) => onDraftChange(row.id, level, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onCommit(row.id)
                }}
              />
            </label>
          ))}
        </div>
        <div className="dsha-capacity-control">
          <button type="button" className="dsha-context-save" disabled={row.saving} onClick={() => onCommit(row.id)}>
            {row.saving ? labels.saving : labels.save}
          </button>
          <button
            type="button"
            className="dsha-context-save dsha-context-reset"
            aria-label={`${row.name} ${labels.reset}`}
            disabled={row.saving || !row.hasOverride}
            onClick={() => onReset(row.id)}
          >
            {labels.reset}
          </button>
        </div>
      </div>
    ))}
  </div>
}
