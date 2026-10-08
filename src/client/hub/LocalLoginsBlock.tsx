/**
 * The hub overview's local sign-in block: which locally installed AI CLIs on this
 * machine have a sign-in this plugin could reuse, and one click to import the
 * Codex one.
 *
 * EVERY ROW COMES FROM THE HOST. The scan decides which providers exist, in
 * which order, and whether each has something to import; a client-side copy of
 * that list would be a second answer to a question the host already owns, and it
 * would go stale the moment a provider is added.
 *
 * NOTHING HERE READS A CREDENTIAL, AND THAT IS WHY SO LITTLE IS SHOWN. The host
 * answers presence only — a file is there, or it is not — so this block shows
 * presence, the paths it consulted, and one button. It deliberately renders no
 * account, plan, address or expiry for a detected sign-in: those answers exist
 * only after the user imports, and showing nothing before that is the feature,
 * not a gap in it.
 *
 * A 'settings-only' row gets no import button. Its provider already owns an
 * import control elsewhere in settings, and a second one for the same file would
 * be a second thing to keep in step with the first.
 */
import type { LocalLoginSourceDto, LocalLoginSourceId } from '../../shared/contracts.ts'
import { formatPoolLabel } from '../common/account-pool-labels.ts'
import type { HubTranslate } from './HubOverview.tsx'
import { useLocalLogins } from './useLocalLogins.ts'

export interface LocalLoginsBlockProps {
  t: HubTranslate
  /** Called after a successful import, so the page can re-read the line cards. */
  onImported?(): void
}

export function LocalLoginsBlock({ t, onImported }: LocalLoginsBlockProps): React.JSX.Element {
  const { sources, loadError, busy, importError, load, adopt } = useLocalLogins(onImported)

  return <section className="dsh-hub-locals" aria-labelledby="dsh-hub-locals-title">
    <h3 id="dsh-hub-locals-title" className="dsh-hub-locals-title">{t('localLoginsTitle')}</h3>
    <p className="dsh-hub-locals-hint">{t('localLoginsHint')}</p>

    {importError !== null ? <div className="dsh-codex-errorbar" role="alert"><span>{importError}</span></div> : null}

    {/* The load error is shown whether or not rows survived it: a scan that goes
        bad after a good one leaves the earlier rows true, and hiding the reason
        behind them would leave the user reading a list nobody refreshed. */}
    {loadError !== null ? <div className="dsh-codex-errorbar" role="alert">
      <span>{loadError}</span>
      <button type="button" className="dsh-codex-button" onClick={() => void load()}>{t('retry')}</button>
    </div> : null}

    {/* `Array.isArray` is redundant against the hook's own check and stays on
        purpose. This block sits inside a settings page whose other cards do not
        depend on this request, so the cost of being wrong here is not a broken
        row but an unmounted page. */}
    {sources === null
      ? loadError === null
        ? <div className="dsh-hub-local-skeleton" role="status" aria-label={t('loading')}><i /><span /></div>
        : null
      : <div className="dsh-hub-local-list">
        {(Array.isArray(sources) ? sources : []).map((source) => (
          <LocalLoginRow
            key={source.id}
            source={source}
            busy={busy === source.id}
            blocked={busy !== null}
            t={t}
            onAdopt={adopt}
          />
        ))}
      </div>}
  </section>
}

function LocalLoginRow(props: {
  source: LocalLoginSourceDto
  busy: boolean
  /** Set while any import runs; the block commits one row at a time. */
  blocked: boolean
  t: HubTranslate
  onAdopt(source: LocalLoginSourceId): Promise<void>
}): React.JSX.Element {
  const { source, t } = props
  // An 'adopt' row whose source the host did not find offers nothing: the import
  // would only come back with the host's "no usable local sign-in" sentence, and
  // a button beside an explicit "not detected" that can never succeed is noise.
  const importable = source.importMode === 'adopt' && source.detected

  return <div className="dsh-hub-local-row" aria-busy={props.busy}>
    <span className="dsh-hub-local-copy">
      <span className="dsh-hub-local-name">{source.providerLabel}</span>
      <span className="dsh-hub-local-state" data-detected={source.detected}>
        {source.detected ? t('localLoginDetected') : t('localLoginNotDetected')}
      </span>
      {source.importMode === 'settings-only' ? <span className="dsh-hub-local-note">{t('localLoginSettingsOnly')}</span> : null}
      {/* The paths the host consulted, shown on every row and not only the found
          one: "where did you look?" is most often asked about the row that found
          nothing. */}
      <span className="dsh-hub-local-paths">
        {(Array.isArray(source.paths) ? source.paths : []).map((path) => <code key={path} className="dsh-hub-local-path" title={path}>{path}</code>)}
      </span>
    </span>
    {importable ? (
      <button
        type="button"
        className="dsh-codex-button"
        aria-label={formatPoolLabel(t('localLoginImportLabel'), { name: source.providerLabel })}
        disabled={props.blocked}
        onClick={() => { void props.onAdopt(source.id) }}
      >{props.busy ? t('localLoginImporting') : t('localLoginImport')}</button>
    ) : null}
  </div>
}
