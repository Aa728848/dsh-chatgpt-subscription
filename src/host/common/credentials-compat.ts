/**
 * The record half of DSH's credential seam (`ctx.credentials`), as this plugin
 * needs it, without taking a dependency on the package that declares it.
 *
 * WHY A LOCAL SHAPE instead of `import type {} from '@deepseek-ai/dsh-credentials'`:
 * the seam only exists from harness 0.2 on, and this one code base still installs
 * on every generation back to 0.1.2-alpha.5 (see the peer range in package.json).
 * A type-only import would make the plugin's own compilation depend on a package
 * the host we have to support may not ship, and would state a peer relationship
 * that is not true at runtime. The shape below is the part of `CredentialProvider`
 * this plugin actually calls, verified against the shipped declaration
 * (`readRecord` / `modifyRecord` / `deleteRecord`), so a host that carries the
 * seam satisfies it structurally and one that does not falls through to the
 * next backend.
 *
 * The records half is the right half for a pool document: a `grant` record's
 * payload is owner-defined JSON that the seam never reads or reshapes, while the
 * reference half (`set`/`unset`) is an environment-variable-shaped string slot
 * meant for API keys. Serializing the pool into a string slot would work, but it
 * would address the pool as `SOME_ENV_NAME` and put a whole account document in a
 * namespace reserved for keys a request authenticates with.
 */

/** One stored credential record, in the only form this plugin writes: an owner-defined grant. */
export interface CredentialGrantRecord {
  readonly kind: 'grant'
  readonly payload: unknown
}

/**
 * One `<scope>/<id>` segment, exactly as the seam's own `credentialKey` requires.
 *
 * Copied from the shipped builder (`@deepseek-ai/dsh-credentials`,
 * `KEY_SEGMENT_PATTERN`) rather than invented: a key that this plugin builds and
 * the seam rejects is worse than no seam at all — the write succeeds, the record
 * document stops parsing on the next start, and every credential on the host
 * goes with it.
 */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/** Whether one segment of a record key could be handed to the seam at all. */
export function isCredentialKeySegment(value: string): boolean {
  return KEY_SEGMENT_PATTERN.test(value)
}

/**
 * The seam calls this plugin makes.
 *
 * `key` is a `<scope>/<id>` string. The package's own builder brands it as
 * `CredentialKey` and validates both segments against {@link KEY_SEGMENT_PATTERN};
 * brands are erased at runtime, so the check is done here instead — in
 * {@link credentialsRecordKey} — and passing the plain string is then the same
 * call the branded one makes.
 */
export interface CredentialsRecordSeam {
  readRecord(key: string): Promise<CredentialGrantRecord | undefined>
  modifyRecord(
    key: string,
    mutate: (current: CredentialGrantRecord | undefined) => Promise<CredentialGrantRecord | undefined>,
  ): Promise<CredentialGrantRecord | undefined>
  deleteRecord(key: string): Promise<void>
}

/**
 * The seam, when `ctx.get('credentials')` returned something that is one.
 *
 * Takes the resolved SERVICE rather than the context: on a Cordis context a
 * service outside `inject` may only be read through `ctx.get`, so the lookup
 * belongs to the plugin entry (`src/index.ts`) and this function only decides
 * whether what came back is the record half the pool can use.
 *
 * Verified by shape, not by `!== undefined`: a host may carry a name that is not
 * this seam, and a service answering half the calls would fail in the middle of a
 * save — after the token exchange, which is exactly the failure the `poolStorage`
 * option exists to remove.
 */
export function asCredentialsSeam(service: unknown): CredentialsRecordSeam | undefined {
  if (typeof service !== 'object' || service === null) return undefined
  const candidate = service as Partial<CredentialsRecordSeam>
  if (typeof candidate.readRecord !== 'function'
    || typeof candidate.modifyRecord !== 'function'
    || typeof candidate.deleteRecord !== 'function') {
    return undefined
  }
  return candidate as CredentialsRecordSeam
}

/**
 * Address of one pool document inside the seam's record space.
 *
 * Scoped by plugin rather than by provider line: a record's payload is written in
 * its owner's format, so two lines of this plugin may share the scope and stay
 * apart by id.
 *
 * Both segments are validated HERE, by the seam's own rule, because the seam's
 * write path does not validate them: a key it would reject on the next start
 * (`parseCredentialKey` runs in `parseRecords`, and an invalid one fails the
 * provider's activation) is a key that must never be written at all. A caller
 * that cannot build a legal id gets a `TypeError` now, in the line that named it,
 * instead of a credential document that stops loading after a restart.
 */
export function credentialsRecordKey(scope: string, id: string): string {
  for (const segment of [scope, id]) {
    if (!isCredentialKeySegment(segment)) {
      throw new TypeError(`credential key segment "${segment}" must match ${String(KEY_SEGMENT_PATTERN)}`)
    }
  }
  return `${scope}/${id}`
}
