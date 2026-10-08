/**
 * The unified, read-only scan of every local sign-in this plugin can adopt.
 *
 * WHY IT EXISTS. Three separate lines in this package can reuse a sign-in the user
 * already has — the Codex CLI, Claude Code, and the MiniMax Code desktop app — and
 * each of them grew its own reader with its own path rules, its own opt-in flow
 * and its own idea of what "found it" means. A settings page that has to ask three
 * questions three ways is a page that gets them wrong. This module is the one
 * question: what is on this machine that could be reused, right now?
 *
 * ---------------------------------------------------------------------------
 * IT PERFORMS PRESENCE ONLY. NOTHING HERE READS A TOKEN.
 * ---------------------------------------------------------------------------
 * Every row below is answered by stat, never by opening a file. The reason is not
 * caution but the shape of the feature: the scan runs to RENDER AN OFFER, before
 * the user has agreed to anything. A scanner that read the files would make the
 * opt-in behind each import decorative, and would hold three subscriptions' tokens
 * in memory for a page that only needs a yes or no.
 *
 * Consequently 'detected' means a file is there, NOT that it is usable. Answering
 * usability would require the read this module exists to avoid; that question is
 * answered by each line's own import action, after the user opts in.
 *
 * ---------------------------------------------------------------------------
 * IT REUSES THE THREE READERS; IT NEVER RE-IMPLEMENTS ONE
 * ---------------------------------------------------------------------------
 * Claude Code and MiniMax Code each already own their semantics, and a second copy
 * of either would be a second thing to keep in step. So this scanner calls the
 * EXISTING presence helpers and reports the paths they consulted:
 *
 * - codex — this line's own reader, 'codex-adopt.ts'.
 * - claude-code — 'claude/adopt.ts''.s own presence function, unchanged. That
 *   line's adopt-and-refresh policy is its own business; the scanner only reports
 *   whether a file exists.
 * - minimax-code — the native auth.json path helper from
 *   'minimax-code/token-store.ts'. MiniMax's line DOES renew a native credential
 *   in place, by design and with its own atomic-replace rules; nothing here reads
 *   that file or touches those rules.
 *
 * The two 'settings-only' rows say why: their providers already own an import
 * control, so the honest answer is to point the user at it rather than invent a
 * second import path that would have to be kept in step with the first.
 */

// stat, BY NAME and nothing else, for the same reason 'codex-adopt.ts' imports
// only readFile and stat: a module whose only filesystem act is a stat cannot
// accidentally grow a write without that showing up as a visible import change.
import { stat } from 'node:fs/promises'
import type { LocalLoginScanDto, LocalLoginSourceDto, LocalLoginSourceId } from '../shared/contracts.ts'
import {
  codexCliCredentialPaths,
  codexCliCredentialPresence,
} from './codex-adopt.ts'
import {
  claudeCodeCredentialPaths,
  claudeCodeCredentialPresence,
} from './claude/adopt.ts'
import { authJsonPath } from './minimax-code/token-store.ts'
import type { MinimaxCodeRegion } from '../shared/minimax-code-contracts.ts'

/**
 * Regions whose native MiniMax auth file is consulted.
 *
 * Both, because which one a user signed in to is exactly what a presence check
 * cannot learn: asking costs a stat each, and reporting both is more useful than
 * guessing one. The list is a constant rather than a setting because a user who
 * signed in to one of them did so in a way the app decides, not this plugin.
 */
const MINIMAX_CODE_REGIONS: readonly MinimaxCodeRegion[] = ['cn', 'global']

/**
 * Override the paths each row consults. Test seam, never set in production.
 *
 * Present because the three readers resolve their own paths from environment
 * variables, and a test needs to point all three at fixtures rather than at the
 * developer's real home. Production callers take the default and every row answers
 * for the paths the corresponding reader would actually use.
 */
export interface LocalLoginScanOptions {
  codexPaths?: readonly string[]
  claudePaths?: readonly string[]
  minimaxPaths?: readonly string[]
}

async function present(paths: readonly string[]): Promise<boolean> {
  // The stat is this module's only act. A failure to establish existence answers
  // "no": this runs while the settings page renders, and a missing file must not
  // be able to fail the whole scan. Both helpers below already treat every error
  // as absence, so the catch here is the belt to that braces.
  for (const candidate of paths) {
    try {
      if ((await stat(candidate)).isFile()) return true
    } catch {
      continue
    }
  }
  return false
}

/** One row, built from whatever the provider's own reader already knows. */
function row(
  id: LocalLoginSourceId,
  providerLabel: string,
  importMode: LocalLoginSourceDto['importMode'],
  detected: boolean,
  paths: string[],
): LocalLoginSourceDto {
  return { id, providerLabel, importMode, detected, paths: [...paths] }
}

/**
 * Every local sign-in this plugin knows how to reuse, in a uniform shape.
 *
 * Order is fixed and stated rather than derived: the three rows are the three
 * providers, in the order their names appear in the id union, so two calls with no
 * change on disk produce the same list and a client can index it.
 *
 * Never throws. Every reader's failure is a 'detected: false' row rather than a
 * rejected promise, because this feeds a page render: a settings card that fails to
 * open because a provider's file is unreadable is worse than one that offers
 * nothing for it.
 */
export async function scanLocalLogins(options: LocalLoginScanOptions = {}): Promise<LocalLoginScanDto> {
  const codexPaths = options.codexPaths ?? codexCliCredentialPaths()
  const claudePaths = options.claudePaths ?? claudeCodeCredentialPaths()
  const minimaxPaths = options.minimaxPaths ?? MINIMAX_CODE_REGIONS.map((region) => authJsonPath(region))

  const [codexDetected, claudeDetected, minimaxDetected] = await Promise.all([
    // This line's own reader, which stats and never opens. It is the single source
    // of truth for the Codex CLI's path rules, including the CODEX_HOME override.
    codexCliCredentialPresence(codexPaths).catch(() => false),
    // The Claude line's own presence function, untouched. Importing it is the
    // point: a second Claude reader here would be a second thing to keep in step
    // with the first, and a place for the two to disagree about where the file is.
    claudeCodeCredentialPresence(claudePaths).then((presence) => presence.present).catch(() => false),
    // MiniMax's own path helper. Existence only — that line's native file is one
    // it renews in place, and this module never opens it.
    present(minimaxPaths),
  ])

  return {
    sources: [
      // 'adopt': this line has an import route, so one click is genuinely one click.
      row('codex', 'Codex CLI', 'adopt', codexDetected, [...codexPaths]),
      // 'settings-only': the Claude line already owns an import control. Pointing
      // the user at it is more honest than adding a second path to the same file
      // that could disagree with the first.
      row('claude-code', 'Claude Code', 'settings-only', claudeDetected, [...claudePaths]),
      // 'settings-only' for the same reason: the MiniMax line reads and renews its
      // native sign-in under its own rules, and a second importer here would have
      // to duplicate them.
      row('minimax-code', 'MiniMax Code', 'settings-only', minimaxDetected, [...minimaxPaths]),
    ],
  }
}
