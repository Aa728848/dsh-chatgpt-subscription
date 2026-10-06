/**
 * The shared "which models appear in the picker" list every provider section
 * renders.
 *
 * The visual language follows the claude-style model picker: one row per
 * model — vendor mark, name, a single quiet hint line (context window when
 * the catalog carries one) — with the selection state drawn as a trailing
 * check dot instead of a bare checkbox. Unlike the picker this list is
 * multi-select, so rows are `role="checkbox"` and the header carries the
 * select-all / clear-all pair the old checkbox blocks had.
 *
 * One component rather than eight near-identical blocks: sections differ only
 * in where the items come from and which dictionary supplies the labels.
 */
import { BrandMark, modelBrandMark } from '../hub/brand-icons.tsx'

export interface ModelChecklistItem {
  id: string
  name: string
  /** One quiet line under the name (e.g. the context window); omit when none. */
  hint?: string
  enabled: boolean
}

export interface ModelChecklistLabels {
  selectAll: string
  clearAll: string
  /**
   * `{count}` and `{total}` are replaced with the enabled/total numbers.
   * Optional: a provider dictionary without the key gets the bare "3/8" form.
   */
  countTemplate?: string
  /** aria-label of the list itself; omit when the section header already names it. */
  list?: string
}

interface Props {
  items: ModelChecklistItem[]
  /** Disables every row and the header buttons while a commit is in flight. */
  busy: boolean
  onToggle(id: string, enabled: boolean): void
  onToggleAll(enabled: boolean): void
  labels: ModelChecklistLabels
}

const CHECK_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 5"/></svg>'

export function ModelChecklist({ items, busy, onToggle, onToggleAll, labels }: Props): React.JSX.Element {
  const enabledCount = items.filter((item) => item.enabled).length
  const count = (labels.countTemplate ?? '{count}/{total}')
    .replace('{count}', String(enabledCount))
    .replace('{total}', String(items.length))
  return <div className="dsh-mcl">
    <div className="dsh-mcl-head">
      <span className="dsh-mcl-count">{count}</span>
      <span className="dsh-mcl-head-actions">
        <button type="button" className="dsh-mcl-action" disabled={busy || enabledCount === items.length} onClick={() => onToggleAll(true)}>{labels.selectAll}</button>
        <button type="button" className="dsh-mcl-action" disabled={busy || enabledCount === 0} onClick={() => onToggleAll(false)}>{labels.clearAll}</button>
      </span>
    </div>
    <div className="dsh-mcl-list" role="group" aria-label={labels.list}>
      {items.map((item) => {
        const mark = modelBrandMark(item.id)
        return <button
          key={item.id}
          type="button"
          role="checkbox"
          aria-checked={item.enabled}
          className="dsh-mcl-option"
          data-enabled={item.enabled}
          disabled={busy}
          title={item.id}
          onClick={() => onToggle(item.id, !item.enabled)}
        >
          {mark !== null ? <BrandMark mark={mark} size={18} /> : null}
          <span className="dsh-mcl-copy">
            <span className="dsh-mcl-name">{item.name}</span>
            {item.hint !== undefined ? <span className="dsh-mcl-hint">{item.hint}</span> : null}
          </span>
          <span className="dsh-mcl-check" aria-hidden="true" dangerouslySetInnerHTML={{ __html: item.enabled ? CHECK_SVG : '' }} />
        </button>
      })}
    </div>
  </div>
}
