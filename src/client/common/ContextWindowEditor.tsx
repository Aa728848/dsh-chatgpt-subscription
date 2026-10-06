/**
 * The shared "model context windows" block every provider settings card renders.
 *
 * Six cards had grown near-identical copies of this markup: one row per enabled
 * model, a free-text capacity input, a save button, a restore button, and a
 * batch restore. Only these things ever differed between them —
 *
 *   - the words (each card's dictionary, plus WorkBuddy's hardcoded `tokens`
 *     and the hardcoded English `context window` input label four of them carry);
 *   - whether a row shows the model's effective window beside the name when it
 *     exceeds the model's default, and which stylesheet class that figure wears;
 *   - whether the capacity input carries an `aria-label` at all (Antigravity's
 *     does not);
 *   - how a save or a restore is carried out, which stays in each card because
 *     WorkBuddy normalizes its status payload and Antigravity confirms the batch
 *     restore first.
 *
 * Everything the rows and callbacks need is therefore the whole interface: the
 * editor parses, seeds and stores nothing.
 */
import { formatCapacity } from './format.ts'

export interface ContextWindowRow {
  /** Model id: the row key, the name's tooltip, and what the callbacks receive. */
  id: string
  name: string
  /**
   * The free-text draft the card owns. The editor never parses it and never
   * falls back to a default, because a half-typed value has to survive a render.
   */
  draft: string
  /** Window figure shown beside the name; the cards that show one format it themselves. */
  meta?: string
  /** `aria-label` of this row's input; the one card that labels it with nothing omits it. */
  inputLabel?: string
  /**
   * Whether the host stores an override for this model. A model with none has
   * nothing to drop, so its restore button stays disabled.
   */
  hasOverride: boolean
  /** True while this row's save or restore request is in flight. */
  saving: boolean
}

export interface ContextWindowLabels {
  /** Unit rendered after every capacity input. */
  tokens: string
  save: string
  saving: string
  reset: string
  resetAll: string
  /** Sentence shown while no enabled model has a row. */
  empty: string
}

/** The slice of a line's status payload the draft seeding reads. */
export interface ContextWindowStatus {
  models: readonly { id: string; defaultContextWindow: number }[]
  contextWindowOverrides: Record<string, number>
}

/**
 * Seed one draft per model from a status payload, so the input shows the stored
 * override and falls back to the catalog length.
 *
 * Run after a model toggle too: a model that was just enabled has no draft yet,
 * and only enabled models get a row — without this, its row would render an
 * empty input that a save would then reject as unparsable.
 */
export function contextDraftsFor(status: ContextWindowStatus): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const model of status.models) {
    drafts[model.id] = formatCapacity(status.contextWindowOverrides[model.id] || model.defaultContextWindow)
  }
  return drafts
}

interface Props {
  rows: ContextWindowRow[]
  labels: ContextWindowLabels
  /** Disables the batch restore while any other request is in flight. */
  busy: boolean
  /**
   * Counts every stored override, including keys left by models the picker no
   * longer lists — which is why the batch button can be live while no visible
   * row offers a restore.
   */
  overrideCount: number
  /** Class the meta figure wears; each line draws it from its own stylesheet. */
  metaClassName?: string
  onDraftChange(id: string, draft: string): void
  onCommit(id: string): void
  onReset(id: string): void
  onResetAll(): void
}

export function ContextWindowEditor({
  rows,
  labels,
  busy,
  overrideCount,
  metaClassName,
  onDraftChange,
  onCommit,
  onReset,
  onResetAll,
}: Props): React.JSX.Element {
  return <div className="dsha-context-settings">
    {rows.length === 0 ? <p className="dsha-muted">{labels.empty}</p> : null}
    {rows.map((row) => (
      <div key={row.id} className="dsha-context-row">
        <span title={row.id}>
          {row.name}
          {row.meta !== undefined ? <span className={metaClassName}>{row.meta}</span> : null}
        </span>
        <div className="dsha-capacity-control">
          <input
            type="text"
            aria-label={row.inputLabel}
            value={row.draft}
            onChange={(event) => onDraftChange(row.id, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onCommit(row.id)
            }}
          />
          <small>{labels.tokens}</small>
          <button
            type="button"
            className="dsha-context-save"
            disabled={row.saving}
            onClick={() => onCommit(row.id)}
          >
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
    <div className="dsha-actions">
      <button type="button" className="dsha-btn" disabled={busy || overrideCount === 0} onClick={onResetAll}>
        {labels.resetAll}
      </button>
    </div>
  </div>
}
