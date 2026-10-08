/**
 * The hub's local sign-in block, minus its markup: one read-only scan and one
 * import, with their busy and failure states.
 *
 * Split out the way every provider's section splits its data from its view, so
 * the block file stays readable as layout and this stays as behavior.
 *
 * TWO FAILURES ARE KEPT APART ON PURPOSE. A scan that never arrived leaves the
 * block with nothing to show and offers a retry; an import the host refused
 * leaves rows that are still true, so the host's own sentence is shown beside
 * them. Collapsing the two would either drop a still-accurate list or hide a
 * refusal behind a page-level "could not load".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalLoginScanDto, LocalLoginSourceDto, LocalLoginSourceId } from '../../shared/contracts.ts'
import { SubscriptionApi } from '../api.ts'

export interface LocalLoginsState {
  /** The host's rows, or null while no renderable scan has landed. */
  sources: LocalLoginSourceDto[] | null
  loadError: string | null
  /** The source whose import is in flight; null while idle. */
  busy: LocalLoginSourceId | null
  importError: string | null
  load(): Promise<void>
  adopt(source: LocalLoginSourceId): Promise<void>
}

export function useLocalLogins(onImported?: () => void): LocalLoginsState {
  const apiRef = useRef(new SubscriptionApi())
  // Read through a ref so an inline callback from the page cannot rebuild the
  // import handler, and with it the row that owns the busy state, per render.
  const onImportedRef = useRef(onImported)
  const [sources, setSources] = useState<LocalLoginSourceDto[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<LocalLoginSourceId | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    onImportedRef.current = onImported
  }, [onImported])

  const load = useCallback(async (): Promise<void> => {
    try {
      const sources = readSources(await apiRef.current.localLogins())
      if (sources === null) {
        setLoadError(UNREADABLE_SCAN)
        return
      }
      setSources(sources)
      setLoadError(null)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const adopt = useCallback(async (source: LocalLoginSourceId): Promise<void> => {
    setBusy(source)
    setImportError(null)
    try {
      // The route answers with the refreshed plugin status, so the import's
      // outcome needs no second status call here. That answer is awaited and
      // never read: a status this block has no use for must not become a way to
      // crash it, and a refused import already arrives as a thrown error.
      //
      // The scan is then re-read rather than assumed: adopting copies the CLI's
      // own sign-in and never removes that file, so a row left untouched would be
      // reporting the pre-import machine.
      await apiRef.current.adoptLocalLogin(source)
      await load()
      onImportedRef.current?.()
    } catch (error) {
      // The host's sentence, not a kinder one. It is the only party that opened
      // the file, and a paraphrase would hide why the import was refused.
      setImportError(messageOf(error))
    } finally {
      setBusy(null)
    }
  }, [load])

  return { sources, loadError, busy, importError, load, adopt }
}

/**
 * The rows a scan answer can actually be rendered from, or null when the answer
 * was not a scan at all.
 *
 * `request()` unwraps the envelope and stops there: it does not know what any one
 * route's value must look like, so a 200 carrying some other object's shape arrives
 * here intact. The host is careful never to let one unreadable provider fail the
 * whole scan, and a client that crashed on a half-shaped answer would undo that at
 * the render: this block shares a settings page with the cards of every other
 * provider, none of which depend on this request.
 *
 * There is deliberately no fallback list. A client-side copy of the three providers
 * would be a second answer to a question only the host owns, and it would quietly
 * reappear in the UI of a host that dropped one of them.
 */
function readSources(scan: LocalLoginScanDto): LocalLoginSourceDto[] | null {
  const sources = (scan as { sources?: unknown } | null | undefined)?.sources
  if (!Array.isArray(sources)) return null
  // A row without an id cannot be keyed or named, so it is not a row this block
  // can show; dropping it keeps one bad entry from taking the page down.
  return sources.filter((row): row is LocalLoginSourceDto => typeof row?.id === 'string')
}

/**
 * The host answered, but not with a scan.
 *
 * Plain English and outside the dictionary, for the same reason api.ts's
 * `Request failed (n)` is: it describes this plugin's own wiring being wrong rather
 * than a fact about the user's machine, and it sits beside a retry the user can act
 * on.
 */
const UNREADABLE_SCAN = 'The host answered the local sign-in scan with an unexpected shape.'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
